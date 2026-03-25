import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { OrderMessageSchema } from "../src/schemas/order-message.js";
import { ResultMessageSchema } from "../src/schemas/result-message.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const schemasDir = resolve(currentDir, "..", "schemas");

mkdirSync(schemasDir, { recursive: true });

const schemas = [
  {
    name: "order-message",
    schema: OrderMessageSchema,
    title: "OrderMessage",
    description: "Task order sent to the Order Queue for worker processing",
    id: "https://github.com/qlibin/tg-assistant-infra/schemas/order-message/1.0.0",
  },
  {
    name: "result-message",
    schema: ResultMessageSchema,
    title: "ResultMessage",
    description:
      "Processing result sent to the Result Queue for feedback handling",
    id: "https://github.com/qlibin/tg-assistant-infra/schemas/result-message/1.0.0",
  },
] as const;

for (const { name, schema, title, description, id } of schemas) {
  const jsonSchema = zodToJsonSchema(schema, {
    name: title,
    $refStrategy: "none",
  });

  const output = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: id,
    title,
    description,
    ...jsonSchema.definitions?.[title],
  };

  const filePath = resolve(schemasDir, `${name}.schema.json`);
  writeFileSync(filePath, JSON.stringify(output, null, 2) + "\n");

  // eslint-disable-next-line no-console
  console.log(`Generated ${filePath}`);
}
