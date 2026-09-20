import { strictObjectSchema } from "./aiProtocol.mjs";

const revisionProperty = {
  type: "integer",
  minimum: 0,
  description: "The canonical map revision returned by the most recent get_map or tool result.",
};

const nodeReferenceProperty = (description) => ({
  type: "string",
  minLength: 1,
  description: `${description} Use a stable node id, or $selected only when exactly one bubble is selected.`,
});

const nullableString = (description) => ({
  type: ["string", "null"],
  description,
});

const nullableNumber = (description, { integer = false } = {}) => ({
  type: [integer ? "integer" : "number", "null"],
  description,
});

const transcriptQuotes = {
  type: "array",
  items: { type: "string", minLength: 1 },
  description: "Additional exact user quotes when one idea spans several finalized speech fragments. Use an empty array when one quote is enough or no provenance applies.",
};

export const PROPOSAL_EVIDENCE_INPUT_SCHEMA = strictObjectSchema({
  quote: {
    type: "string", minLength: 1,
    description: "An exact transcript quote. The server resolves and validates its character span.",
  },
});

// Proposal operations intentionally use one strict, nullable record rather than a
// loose object. The operation reducer performs the final type-specific validation.
export const PROPOSAL_OPERATION_SCHEMA = strictObjectSchema({
  id: nullableString("A stable operation id. Use null to have the server assign one."),
  type: {
    type: "string",
    enum: ["create_bubble", "edit_bubble", "revisit_bubble", "connect_bubbles", "delete_bubble", "delete_connection"],
  },
  node_id: nullableString("The target node id or $selected for edit_bubble, revisit_bubble, and delete_bubble."),
  from: nullableString("The source node id or $selected for connect_bubbles."),
  to: nullableString("The target node id or $selected for connect_bubbles."),
  edge_id: nullableString("The stable edge id for delete_connection."),
  text: nullableString("Bubble text for create_bubble or edit_bubble."),
  depth: nullableNumber("Optional structural depth for create_bubble; otherwise null.", { integer: true }),
  x: nullableNumber("Optional committed x position for create_bubble; otherwise null."),
  y: nullableNumber("Optional committed y position for create_bubble; otherwise null."),
  parent: nullableString("An optional parent node id or $selected for create_bubble."),
  quote: nullableString("An exact quote from a finalized user transcript item."),
  excluded: {
    type: "boolean",
    description: "Whether this operation has been excluded from the proposal before review.",
  },
});

export const functionTool = (name, description, properties, required = Object.keys(properties)) => ({
  type: "function", name, description, strict: true,
  parameters: strictObjectSchema(properties, required),
});

export const MAP_TOOL_DEFINITIONS = Object.freeze([
  functionTool(
    "get_map",
    "Read the complete canonical map, including the explicit central_node_id, revision, every bubble and connection, layout positions, pending proposals, and current selection. Use only for an explicit request about the map, to resolve an ambiguous target in an explicit map request, or after a revision conflict.",
    {},
    [],
  ),
  functionTool(
    "create_bubble",
    "Create a bubble only when the user explicitly asks to add or capture an idea on the map. Use the simplest faithful noun phrase supported by finalized transcript text.",
    {
      text: { type: "string", minLength: 1, description: "A concise bubble label preserving the speaker's idea." },
      quote: nullableString("The exact user words supporting this bubble, or null when it is not sourced from the transcript. The server resolves all provenance identifiers and offsets."),
      quotes: transcriptQuotes,
      parent_reference: nullableString("A confident parent node id or $selected; null creates an unconnected bubble."),
      expected_revision: revisionProperty,
    },
  ),
  functionTool(
    "set_central_idea",
    "Make one idea the map's central/root bubble only when the user explicitly asks. Supply either node_reference for an existing bubble or text for a new sourced bubble, but not both. The change is atomic and reversible.",
    {
      node_reference: nullableString("An existing bubble id or $selected to promote, or null when creating a new central bubble."),
      text: nullableString("The simplest faithful label for a new central bubble, or null when promoting an existing bubble."),
      quote: nullableString("The exact user words supporting the central idea, or null. The server resolves all provenance identifiers and offsets."),
      quotes: transcriptQuotes,
      expected_revision: revisionProperty,
    },
  ),
  functionTool(
    "edit_bubble",
    "Replace an existing bubble label after a clear user request while preserving its semantic identity and existing provenance. Do not use this to turn one idea into a different idea or to change which bubble is central; use set_central_idea instead.",
    {
      node_reference: nodeReferenceProperty("The bubble to edit."),
      text: { type: "string", minLength: 1, description: "The complete replacement bubble label." },
      quote: nullableString("The exact user words to append as provenance, or null. The server resolves all provenance identifiers and offsets."),
      quotes: transcriptQuotes,
      expected_revision: revisionProperty,
    },
  ),
  functionTool(
    "revisit_bubble",
    "Warm an existing bubble only when the user explicitly asks to revisit or emphasize that mapped idea.",
    {
      node_reference: nodeReferenceProperty("The existing bubble being revisited."),
      quote: nullableString("The exact user words to append as provenance, or null. The server resolves all provenance identifiers and offsets."),
      quotes: transcriptQuotes,
      expected_revision: revisionProperty,
    },
  ),
  functionTool(
    "connect_bubbles",
    "Commit a connection only when the user explicitly requests it.",
    {
      from_reference: nodeReferenceProperty("The source bubble."),
      to_reference: nodeReferenceProperty("The destination bubble."),
      expected_revision: revisionProperty,
    },
  ),
  functionTool(
    "delete_bubble",
    "Delete a bubble and its incident connections only for a clear user-requested target. The protected starting anchor cannot be deleted.",
    {
      node_reference: nodeReferenceProperty("The bubble to delete."),
      expected_revision: revisionProperty,
    },
  ),
  functionTool(
    "delete_connection",
    "Delete one connection only when its stable edge id is known and the user's request is clear.",
    {
      edge_id: { type: "string", minLength: 1, description: "The stable id of the connection to delete." },
      expected_revision: revisionProperty,
    },
  ),
  functionTool(
    "propose_changes",
    "Create one reviewable atomic proposal for an explicit map request whose target, relationship, wording, or destructive interpretation is uncertain. Each operation can later be excluded before acceptance.",
    {
      rationale: { type: "string", minLength: 1, description: "A short user-facing explanation for the proposed batch." },
      evidence: {
        type: "array",
        items: PROPOSAL_EVIDENCE_INPUT_SCHEMA,
        description: "Exact transcript quotes supporting the proposal; use an empty array when none applies. The server resolves canonical character spans.",
      },
      operations: {
        type: "array",
        minItems: 1,
        items: PROPOSAL_OPERATION_SCHEMA,
        description: "The atomic batch of reviewable map operations.",
      },
      expected_revision: revisionProperty,
    },
  ),
  functionTool(
    "exclude_proposal_operation",
    "Exclude one unwanted operation from a pending proposal while keeping the remaining operations reviewable.",
    {
      proposal_id: { type: "string", minLength: 1 },
      operation_id: { type: "string", minLength: 1 },
      expected_revision: revisionProperty,
    },
  ),
  functionTool(
    "undo_map_change",
    "Undo the most recent reversible map change. This never changes the append-only transcript.",
    { expected_revision: revisionProperty },
  ),
  functionTool(
    "redo_map_change",
    "Redo the next reversible map change. This never changes the append-only transcript.",
    { expected_revision: revisionProperty },
  ),
]);

