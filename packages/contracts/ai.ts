export const quoteBody = {
  type:"object",required:["gameId","workspaceRevision","prompt","mode"],additionalProperties:false,
  properties:{
    gameId:{type:"string",format:"uuid"},workspaceRevision:{type:"integer",minimum:0},
    prompt:{type:"string",minLength:3,maxLength:8000},mode:{type:"string",enum:["create","modify"]},
  },
} as const;
export const taskBody = {
  type:"object",required:["quoteId"],additionalProperties:false,
  properties:{quoteId:{type:"string",format:"uuid"}},
} as const;
export const qualityBody = {
  type:"object",required:["description"],additionalProperties:false,
  properties:{description:{type:"string",minLength:10,maxLength:4000}},
} as const;
export const qualityResolutionBody = {
  type:"object",required:["decision","reason"],additionalProperties:false,
  properties:{decision:{type:"string",enum:["repair","refund","reject"]},reason:{type:"string",minLength:3,maxLength:1000}},
} as const;
