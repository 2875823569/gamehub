export const avatarKeys=["dice","fox","cat","panda","robot","rocket","planet","star"] as const;
export type AvatarKey=typeof avatarKeys[number];
export const presetAvatars:Record<AvatarKey,string>={
  dice:"🎲",fox:"🦊",cat:"🐱",panda:"🐼",robot:"🤖",rocket:"🚀",planet:"🪐",star:"⭐",
};
export const avatarLabels:Record<AvatarKey,string>={
  dice:"骰子",fox:"狐狸",cat:"猫咪",panda:"熊猫",robot:"机器人",rocket:"火箭",planet:"星球",star:"星星",
};
export const avatarKeySchema={type:"string",enum:avatarKeys} as const;
export function avatarEmoji(key:unknown):string{
  return typeof key==="string" && Object.hasOwn(presetAvatars,key)?presetAvatars[key as AvatarKey]:presetAvatars.dice;
}
export const publicAuthorData={
  type:"object",additionalProperties:false,required:["id","nickname","avatarKey","games"],
  properties:{
    id:{type:"string",format:"uuid"},nickname:{type:"string"},avatarKey:avatarKeySchema,
    games:{type:"array",items:{
      type:"object",additionalProperties:false,required:["id","title","description","category","versionId"],
      properties:{id:{type:"string",format:"uuid"},title:{type:"string"},description:{type:"string"},category:{type:"string"},versionId:{type:"string",format:"uuid"}},
    }},
  },
} as const;
