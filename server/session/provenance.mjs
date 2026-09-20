import { SessionOperationError, TranscriptPendingError, arrayField } from "./operationInput.mjs";

function occurrenceOffsets(haystack, needle) {
  const offsets = [];
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, cursor);
    if (found < 0) break;
    offsets.push(found);
    cursor = found + Math.max(needle.length, 1);
  }
  return offsets;
}

/** Resolve a model-supplied quote to one and only one exact transcript span. */
export function resolveQuoteSpan(session, request = {}) {
  const nested = request.source && typeof request.source === "object" ? request.source : {};
  const quote = request.quote
    ?? request.transcript_quote
    ?? request.source_quote
    ?? nested.quote;
  const utteranceId = request.utterance_id ?? nested.utterance_id;
  const realtimeItemId = request.realtime_item_id ?? nested.realtime_item_id;
  if (typeof quote !== "string" || !quote.length) {
    throw new SessionOperationError("A non-empty transcript quote is required for provenance.", {
      code: "missing_quote",
      retryable: true,
    });
  }

  let candidates = session.transcript;
  if (utteranceId) {
    candidates = session.transcript.filter((utterance) => utterance.id === utteranceId);
    if (!candidates.length) {
      throw new SessionOperationError(`Transcript utterance “${utteranceId}” does not exist.`, {
        code: "utterance_not_found",
        status: 404,
        retryable: true,
        details: { utterance_id: utteranceId },
      });
    }
  } else if (realtimeItemId) {
    candidates = session.transcript.filter((utterance) => utterance.realtime_item_id === realtimeItemId);
    if (!candidates.length) throw new TranscriptPendingError(realtimeItemId);
  }

  const matches = candidates.flatMap((utterance) => (
    occurrenceOffsets(utterance.text, quote).map((start) => ({
      utterance_id: utterance.id,
      start,
      end: start + quote.length,
      quote,
    }))
  ));
  if (!matches.length) {
    throw new SessionOperationError("The quote was not found verbatim in the completed transcript.", {
      code: "quote_not_found",
      status: 422,
      retryable: true,
      details: { quote, utterance_id: utteranceId, realtime_item_id: realtimeItemId },
    });
  }
  if (matches.length > 1) {
    throw new SessionOperationError("The quote occurs more than once; provide the utterance ID and a unique quote.", {
      code: "ambiguous_quote",
      status: 422,
      retryable: true,
      details: { quote, matches },
    });
  }
  return matches[0];
}

export function exactSource(session, request) {
  const nested = request.source && typeof request.source === "object" ? request.source : null;
  const quote = request.quote ?? request.transcript_quote ?? request.source_quote ?? nested?.quote;
  if (quote === undefined || quote === null || quote === "") return null;

  if (nested && Number.isInteger(nested.start) && Number.isInteger(nested.end) && nested.utterance_id) {
    const utterance = session.transcript.find(({ id }) => id === nested.utterance_id);
    if (!utterance
      || nested.start < 0
      || nested.end < nested.start
      || nested.end > utterance.text.length
      || utterance.text.slice(nested.start, nested.end) !== quote) {
      throw new SessionOperationError("The supplied provenance span is not exact.", {
        code: "invalid_source_span",
        status: 422,
        retryable: true,
      });
    }
    return {
      utterance_id: nested.utterance_id,
      start: nested.start,
      end: nested.end,
      quote,
    };
  }
  return resolveQuoteSpan(session, { ...request, quote });
}

export function exactSources(session, request) {
  const candidates = [];
  const sources = arrayField(request.sources, "sources");
  sources.forEach((source) => candidates.push(exactSource(session, { source, quote: source?.quote })));
  const source = exactSource(session, request);
  if (source) candidates.push(source);
  if (request.quotes !== undefined) {
    arrayField(request.quotes, "quotes").forEach((quote) => {
      if (typeof quote !== "string" || !quote.trim()) {
        throw new SessionOperationError("quotes must contain non-empty exact transcript quotes.", {
          code: "invalid_quotes",
        });
      }
      candidates.push(resolveQuoteSpan(session, { ...request, quote }));
    });
  }
  const seen = new Set();
  return candidates.filter((source) => {
    if (!source) return false;
    const key = `${source.utterance_id}:${source.start}:${source.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function operationProvenance(session, operation) {
  const sourceUtteranceIds = new Set();
  const addUtteranceId = (id) => {
    if (typeof id === "string" && id) sourceUtteranceIds.add(id);
  };
  arrayField(operation.source_utterance_ids, "source_utterance_ids").forEach(addUtteranceId);
  addUtteranceId(operation.utterance_id);
  addUtteranceId(operation.source?.utterance_id);
  arrayField(operation.sources, "sources").forEach((source) => addUtteranceId(source?.utterance_id));
  exactSources(session, operation).forEach((source) => addUtteranceId(source.utterance_id));

  const sourceRealtimeItemId = operation.source_realtime_item_id
    ?? operation.realtime_item_id
    ?? operation.source?.realtime_item_id
    ?? null;
  if (sourceRealtimeItemId) {
    session.transcript
      .filter((utterance) => utterance.realtime_item_id === sourceRealtimeItemId)
      .forEach((utterance) => sourceUtteranceIds.add(utterance.id));
  }
  const inferredRealtimeItems = new Set(
    [...sourceUtteranceIds]
      .map((id) => session.transcript.find((utterance) => utterance.id === id)?.realtime_item_id)
      .filter(Boolean),
  );
  const resolvedRealtimeItemId = sourceRealtimeItemId
    ?? (inferredRealtimeItems.size === 1 ? [...inferredRealtimeItems][0] : null);
  return {
    ...(sourceUtteranceIds.size ? { source_utterance_ids: [...sourceUtteranceIds] } : {}),
    ...(resolvedRealtimeItemId ? { source_realtime_item_id: resolvedRealtimeItemId } : {}),
  };
}

function appendSource(node, source) {
  if (!source) return false;
  const duplicate = node.sources.some((existing) => (
    existing.utterance_id === source.utterance_id
    && existing.start === source.start
    && existing.end === source.end
  ));
  if (!duplicate) node.sources.push(source);
  return !duplicate;
}

export function appendSources(node, sources) {
  return sources.reduce((changed, source) => appendSource(node, source) || changed, false);
}

export function enforceUtteranceBubbleLimit(session, sources) {
  const utteranceIds = new Set(sources.map(({ utterance_id: id }) => id));
  for (const utteranceId of utteranceIds) {
    const sourcedBubbleCount = session.nodes.filter((candidate) => (
      candidate.sources.some((candidateSource) => candidateSource.utterance_id === utteranceId)
    )).length;
    if (sourcedBubbleCount >= 3) {
      throw new SessionOperationError("A completed utterance can contribute at most three bubbles.", {
        code: "utterance_bubble_limit",
        status: 409,
        retryable: true,
        details: { utterance_id: utteranceId, maximum: 3 },
      });
    }
  }
}

