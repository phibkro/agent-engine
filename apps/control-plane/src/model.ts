import * as Schema from "effect/Schema";

export const ModelNameSchema = Schema.Literals(["gpt-oss-120b", "work-engine/gpt-oss-120b"] as const);
export type ModelName = typeof ModelNameSchema.Type;

export const ModelMessageSchema = Schema.Struct({
  role: Schema.Literals(["system", "developer", "user", "assistant", "tool"] as const),
  content: Schema.String,
});
export type ModelMessage = typeof ModelMessageSchema.Type;

export const ModelChatRequestSchema = Schema.Struct({
  model: ModelNameSchema,
  messages: Schema.Array(ModelMessageSchema),
  max_tokens: Schema.optionalKey(Schema.Natural),
  stream: Schema.optionalKey(Schema.Boolean),
});
export type ModelChatRequest = typeof ModelChatRequestSchema.Type;
