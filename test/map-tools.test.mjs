import test from "node:test";
import assert from "node:assert/strict";
import { MAP_TOOL_DEFINITIONS } from "../server/mapTools.mjs";

test("map tools expose the complete supported surface", () => {
  assert.deepEqual(
    MAP_TOOL_DEFINITIONS.map((tool) => tool.name),
    [
      "get_map",
      "create_bubble",
      "set_central_idea",
      "edit_bubble",
      "revisit_bubble",
      "connect_bubbles",
      "delete_bubble",
      "delete_connection",
      "propose_changes",
      "exclude_proposal_operation",
      "undo_map_change",
      "redo_map_change",
    ],
  );
  MAP_TOOL_DEFINITIONS.forEach((tool) => {
    assert.equal(tool.type, "function");
    assert.equal(Object.hasOwn(tool, "strict"), false);
    assert.equal(tool.parameters.type, "object");
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual(new Set(tool.parameters.required), new Set(Object.keys(tool.parameters.properties)));
  });
  assert.deepEqual(
    MAP_TOOL_DEFINITIONS.find((tool) => tool.name === "propose_changes")
      .parameters.properties.operations.items.properties.type.enum,
    ["create_bubble", "edit_bubble", "revisit_bubble", "connect_bubbles", "delete_bubble", "delete_connection"],
  );
  for (const name of ["create_bubble", "edit_bubble", "revisit_bubble"]) {
    const properties = MAP_TOOL_DEFINITIONS.find((tool) => tool.name === name).parameters.properties;
    assert.equal(Object.hasOwn(properties, "quote"), true);
    assert.equal(Object.hasOwn(properties, "quotes"), true);
    assert.equal(Object.hasOwn(properties, "transcript_quote"), false);
    assert.equal(Object.hasOwn(properties, "realtime_item_id"), false);
  }
  const central = MAP_TOOL_DEFINITIONS.find((tool) => tool.name === "set_central_idea");
  assert.deepEqual(Object.keys(central.parameters.properties), [
    "node_reference",
    "text",
    "quote",
    "quotes",
    "expected_revision",
  ]);
  assert.deepEqual(central.parameters.properties.node_reference.type, ["string", "null"]);
  assert.deepEqual(central.parameters.properties.text.type, ["string", "null"]);
});
