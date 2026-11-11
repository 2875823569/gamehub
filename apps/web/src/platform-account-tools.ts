import { api,list,session,restoreSession,PlatformError } from "./platform-client";

function el<K extends keyof HTMLElementTagNameMap>(tag:K,text="",className=""){
  const node=document.createElement(tag);node.textContent=text;node.className=className;return node;
}
function field(container:HTMLElement,label:string,name:string,type="text"){
  const wrap=el("label",label),input=el("input");input.name=name;input.required=true;input.type=type;
  if(type==="tel"){input.pattern="1[3-9][0-9]{9}";input.maxLength=11;input.autocomplete="tel";}
  else if(name.includes("code")){input.pattern="[0-9]{6}";input.maxLength=6;input.inputMode="numeric";input.autocomplete="one-time-code";}
  wrap.append(input);container.append(wrap);return input;
}
function form(container:HTMLElement,label:string,build:(fields:HTMLFieldSetElement)=>void,save:(values:FormData)=>Promise<string>){
  const form=el("form"),fields=el("fieldset"),status=el("p","","error"),button=el("button",label);
  status.setAttribute("role","status");status.setAttribute("aria-live","polite");button.type="submit";
  build(fields);fields.append(status,button);form.append(fields);container.append(form);
  form.onsubmit=async event=>{
    event.preventDefault();if(!form.reportValidity())return;
    const values=new FormData(form);fields.disabled=true;status.textContent="";
    try{status.textContent=await save(values);status.className="notice";}
    catch(error){status.className="error";status.textContent=error instanceof PlatformError?`${error.message}${error.requestId?`（请求编号 ${error.requestId}）`:""}`:error instanceof Error?error.message:"操作失败";}
    finally{fields.disabled=false;}
  };
}
const value=(values:FormData,key:string)=>String(values.get(key)??"").trim();
const states:Record<string,string>={new:"待处理",accepted:"已受理",resolved:"已处理",dismissed:"已驳回",created:"待确认",paid:"已支付",refunded:"已退款",closed:"已关闭",pending:"处理中"};

export async function renderAccountTools(container:HTMLElement,onChange:()=>Promise<unknown>){
  container.replaceChildren();
  if(session.user){
    const phone=el("section","","panel");phone.append(el("h2","更换手机号"),el("p","验证当前手机号和新手机号后，所有账号登录会话将退出，请使用新号码重新登录。","muted"));container.append(phone);
    let oldChallenge="",newChallenge="";
    const challenges=el("div","","grid");phone.append(challenges);
    for(const kind of ["old","new"] as const){
      const box=el("div");challenges.append(box);
      form(box,`获取${kind==="old"?"当前":"新"}号码验证码`,fields=>field(fields,kind==="old"?"当前手机号":"新手机号","phone","tel"),async values=>{
        const data=await api("/auth/sms-challenges","POST",{phone:value(values,"phone"),purpose:`phone-change-${kind}`},"access");
        const id=String(data.challengeId??data.id);if(kind==="old")oldChallenge=id;else newChallenge=id;
        return `验证请求已受理。请向测试组织者领取该次验证码，验证编号：${id}`;
      });
    }
    form(phone,"验证并更换",fields=>{
      field(fields,"当前号码验证码","old-code");field(fields,"新号码验证码","new-code");
    },async values=>{
      if(!oldChallenge||!newChallenge)throw new Error("请先获取两个号码的验证码");
      await api("/me/phone-change","POST",{oldChallengeId:oldChallenge,oldCode:value(values,"old-code"),newChallengeId:newChallenge,newCode:value(values,"new-code")});
      await restoreSession();await onChange();return "手机号已更换，请重新登录。";
    });
  }
  const support=el("section","","panel");
  support.append(el("h2","账号支持"),el("p","账号受限时，可通过独立支持登录查询本人订单与申诉处理结果。","muted"));container.append(support);
  if(!session.support){
    let challengeId="";
    form(support,"获取支持登录验证码",fields=>field(fields,"已注册手机号","phone","tel"),async values=>{
      const result=await api("/auth/sms-challenges","POST",{phone:value(values,"phone"),purpose:"support"},"access");
      challengeId=String(result.challengeId??result.id);return `验证请求已受理。请向测试组织者领取该次验证码，验证编号：${challengeId}`;
    });
    form(support,"登录支持入口",fields=>field(fields,"六位验证码","support-code"),async values=>{
      if(!challengeId)throw new Error("请先获取验证码");
      const result=await api("/auth/sessions","POST",{challengeId,code:value(values,"support-code")},"access");
      session.support=result.user;session.supportCsrf=result.csrfToken;
      await renderAccountTools(container,onChange);return "支持登录成功";
    });
    return;
  }
  support.append(el("p",`当前支持账号：${session.support.nickname}`));
  const logout=el("button","退出支持登录");logout.type="button";support.append(logout);
  logout.onclick=async()=>{
    logout.disabled=true;
    try{await api("/support/sessions/current","DELETE",undefined,"support");session.support=null;session.supportCsrf="";await renderAccountTools(container,onChange);}
    catch(error){support.append(el("p",error instanceof Error?error.message:"退出失败","error"));logout.disabled=false;}
  };
  form(support,"提交账号申诉",fields=>{
    const label=el("label","申诉说明"),reason=el("textarea");reason.name="reason";reason.required=true;reason.maxLength=1000;label.append(reason);fields.append(label);
  },async values=>{
    const result=await api("/support/appeals","POST",{objectType:"account",objectId:session.support!.id,reason:value(values,"reason")},"support");
    await renderAccountTools(container,onChange);return `申诉已受理，编号 ${result.id}`;
  });
  const [orders,appeals]=await Promise.allSettled([api("/support/billing/orders","GET",undefined,"support"),api("/support/appeals","GET",undefined,"support")]);
  for(const [heading,result] of [["本人订单",orders],["申诉记录",appeals]] as const){
    const section=el("section");section.append(el("h3",heading));support.append(section);
    if(result.status==="rejected"){section.append(el("p",result.reason instanceof Error?result.reason.message:"暂时无法读取","error"));continue;}
    const items=list(result.value);
    if(!items.length){section.append(el("p","暂无记录","muted"));continue;}
    for(const row of items){
      const card=el("article","","card");
      card.append(el("p",`编号：${row.id}`),el("p",`状态：${states[row.state??row.status]??row.state??row.status??"未知"}`));
      if(row.reason)card.append(el("p",`说明：${row.reason}`));
      if(row.resolution)card.append(el("p",`处理结果：${row.resolution}`));
      if(row.amountMinor!==undefined)card.append(el("p",`测试金额：${(Number(row.amountMinor)/100).toFixed(2)} ${row.currency??"CNY"}`));
      section.append(card);
    }
  }
}
