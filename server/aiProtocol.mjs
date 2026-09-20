/** Strict records keep required fields and model-visible properties in sync. */
export const strictObjectSchema = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const jsonSchemaFormat = (name, schema) => ({
  format: { type: "json_schema", name, strict: true, schema },
});
