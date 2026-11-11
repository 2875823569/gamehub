export const walletResponse = {
  type: "object", required: ["data","requestId"], additionalProperties: false,
  properties: { data: {
    type: "object", required: ["available","frozen","consumed","testPoints"], additionalProperties:false,
    properties: { available:{type:"integer",minimum:0}, frozen:{type:"integer",minimum:0},
      consumed:{type:"integer",minimum:0}, testPoints:{const:true} },
  }, requestId:{type:"string"} },
} as const;
export const idParams = {
  type:"object", required:["id"], additionalProperties:false,
  properties:{id:{type:"string",format:"uuid"}},
} as const;
export const idempotencyHeaders = {
  type:"object",required:["idempotency-key"],properties:{"idempotency-key":{type:"string",minLength:8,maxLength:100}},
} as const;
export const grantBody = {
  type:"object",required:["userId","points","reason"],additionalProperties:false,
  properties:{userId:{type:"string",format:"uuid"},points:{type:"integer",minimum:1,maximum:10000},
    reason:{type:"string",minLength:3,maxLength:500}},
} as const;
export const orderBody = {
  type:"object",required:["productId","ruleVersion","channel"],additionalProperties:false,
  properties:{productId:{const:"test-100"},ruleVersion:{const:"mock-v1"},channel:{const:"mock"}},
} as const;
export const refundBody = {
  type:"object",required:["reason"],additionalProperties:false,
  properties:{reason:{type:"string",minLength:3,maxLength:1000}},
} as const;
export const jsonEnvelope = {
  type:"object",required:["data","requestId"],additionalProperties:false,
  properties:{data:{type:"object",additionalProperties:true},requestId:{type:"string"}},
} as const;
export const listEnvelope = {
  type:"object",required:["data","requestId"],additionalProperties:false,
  properties:{data:{type:"object",required:["items"],properties:{items:{type:"array",items:{type:"object",additionalProperties:true}},
    nextCursor:{type:["string","null"]}},additionalProperties:true},requestId:{type:"string"}},
} as const;
