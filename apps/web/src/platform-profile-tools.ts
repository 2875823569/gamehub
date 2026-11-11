import { avatarEmoji,avatarKeys,avatarLabels,presetAvatars } from "../../../packages/contracts/profile";
import { api,list,session } from "./platform-client";

function el<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string){
  const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;
}
const errorMessage=(error:unknown)=>error instanceof Error?error.message:"暂时无法完成，请稍后重试";

export async function renderProfileTools(container:HTMLElement,onChange:()=>Promise<unknown>){
  container.replaceChildren();
  if(!session.user){container.append(el("p","登录后可以设置昵称和头像。"));return;}
  const section=el("section");section.className="panel";section.append(el("h2","个人资料"));
  const status=el("p");status.setAttribute("role","status");status.setAttribute("aria-live","polite");
  container.append(section);
  try{
    const profile=await api("/me");
    const form=el("form"),fields=el("fieldset");
    const nicknameLabel=el("label","昵称"),nickname=el("input");
    nickname.name="nickname";nickname.required=true;nickname.maxLength=24;nickname.value=profile.nickname;nickname.setAttribute("autocomplete","nickname");
    nicknameLabel.append(nickname);
    const avatarLabel=el("label","预设头像"),avatars=el("select");avatars.name="avatarKey";
    avatars.setAttribute("aria-label","预设头像");
    for(const key of avatarKeys){const option=el("option",`${presetAvatars[key]} ${avatarLabels[key]}`);option.value=key;avatars.append(option);}
    avatars.value=avatarKeys.includes(profile.avatarKey)?profile.avatarKey:"dice";avatarLabel.append(avatars);
    const preview=el("p",`${avatarEmoji(avatars.value)} 你的头像`);preview.setAttribute("aria-live","polite");
    avatars.addEventListener("change",()=>{preview.textContent=`${avatarEmoji(avatars.value)} 你的头像`;});
    const save=el("button","保存资料");save.type="submit";
    fields.append(nicknameLabel,avatarLabel,preview,el("p","当前使用平台预设头像，暂不支持自定义图片上传。"),save);
    form.append(fields,status);section.append(form);
    const author=el("a","查看我的作者主页");author.href=`#/author/${encodeURIComponent(profile.id)}`;section.append(author);
    form.addEventListener("submit",event=>{
      event.preventDefault();if(!form.reportValidity())return;fields.disabled=true;status.textContent="正在保存…";
      void api("/me/profile","PATCH",{nickname:nickname.value,avatarKey:avatars.value}).then(async updated=>{
        session.user=updated;status.textContent="资料已保存";await onChange();
      }).catch(error=>{status.textContent=errorMessage(error);}).finally(()=>{fields.disabled=false;});
    });
  }catch(error){status.textContent=errorMessage(error);section.append(status);}
}

export async function renderAuthorPage(container:HTMLElement,id:string){
  container.replaceChildren(el("p","正在读取作者资料…"));
  try{
    const author=await api(`/authors/${encodeURIComponent(id)}`),header=el("header");
    header.append(el("h1",`${avatarEmoji(author.avatarKey)} ${author.nickname}`),el("p","作者已发布的内测作品"));
    container.replaceChildren(header);
    const games=list(author.games);
    if(!games.length){container.append(el("p","还没有已发布的内测作品。"));return;}
    const grid=el("div");grid.className="grid";
    for(const game of games){
      const card=el("article");card.className="card";
      const link=el("a",game.title);link.href=`#/game/${encodeURIComponent(game.id)}`;
      const title=el("h2");title.append(link);card.append(title,el("p",game.description),el("small",game.category));grid.append(card);
    }
    container.append(grid);
  }catch(error){const status=el("p",errorMessage(error));status.setAttribute("role","alert");container.replaceChildren(status);}
}
