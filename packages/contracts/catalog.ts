export interface GameManifest {
  schemaVersion: 1;
  entry: string;
  title: string;
  description: string;
  instructions: string;
  cover: string;
  mode: "single" | "multiplayer";
  minPlayers: number;
  maxPlayers: number;
  devices: ("desktop" | "mobile")[];
  input: string[];
  sdkVersion: 1;
  permissions: string[];
  editable: boolean;
  assetLicenses: string[];
  saveSchemaVersion?: number;
  templateId?: string;
  sourceEntry?: string;
  serverEntry?: string;
}
export interface StoredGameFile { digest: string; size: number; mime: string }
export const catalogIdParams = {
  type: "object", additionalProperties: false, required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;
export const catalogResponse = {
  type: "object", additionalProperties: false, required: ["data", "requestId"],
  properties: { data: {}, requestId: { type: "string" } },
} as const;
export const gameCreateBody = {
  type: "object", additionalProperties: false, required: ["title"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 100 },
    description: { type: "string", maxLength: 2000 },
    category: { type: "string", maxLength: 32 },
  },
} as const;
