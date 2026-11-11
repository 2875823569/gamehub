import { api,list,session,type JsonRow } from "./platform-client";

function element<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string){
  const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;
}
function message(error:unknown){return error instanceof Error?error.message:"操作失败，请重试";}
function panel(title:string){const node=element("section");node.className="panel";node.append(element("h2",title));return node;}

/** Every action uses the current server revision/permissions; stale tabs never overwrite drafts. */
export async function renderCreatorTools(container:HTMLElement,game:JsonRow,onChange:()=>Promise<unknown>){
  container.replaceChildren();
  if(!session.user){container.textContent="登录后管理草稿和版本。";return;}
  const status=element("p");status.setAttribute("role","status");container.append(status);
  const action=(label:string,work:()=>Promise<unknown>)=>{
    const button=element("button",label);button.type="button";
    button.addEventListener("click",()=>{button.disabled=true;status.textContent="正在处理…";
      void work().then(()=>{status.textContent="操作完成";}).catch(error=>{status.textContent=message(error);})
        .finally(()=>{button.disabled=false;});});return button;
  };
  const refresh=async()=>{await onChange();};
  const projectId=game.projectId??game.project_id;
  if(projectId){
    const draftPanel=panel("工作草稿与历史快照");container.append(draftPanel);
    try{
      let workspace=await api(`/creator/projects/${projectId}/workspace`);
      const revision=element("p",`当前修订 ${workspace.workspaceRevision} · 基线 ${workspace.baseVersionId??"未选择"}`);
      const label=element("label","草稿内容（JSON 对象，最多 100 KiB）");
      const editor=element("textarea");editor.rows=8;editor.value=JSON.stringify(workspace.draft,null,2);label.append(editor);
      const actions=element("div");actions.className="actions";
      actions.append(action("保存新修订",async()=>{
        const draft:unknown=JSON.parse(editor.value);
        if(!draft || Array.isArray(draft) || typeof draft!=="object")throw new Error("草稿必须是 JSON 对象");
        workspace=await api(`/creator/projects/${projectId}/workspace`,"PATCH",{expectedRevision:workspace.workspaceRevision,draft});
        await refresh();
      }));
      draftPanel.append(revision,label,actions);
      const snapshots=list(await api(`/creator/projects/${projectId}/draft-snapshots`));
      if(!snapshots.length)draftPanel.append(element("p","保存草稿或设置基线后，原修订会出现在这里。"));
      for(const snapshot of snapshots){
        const row=element("div");row.className="row";row.append(element("span",`修订 ${snapshot.revision} · ${new Date(snapshot.created_at).toLocaleString()}`),
          action("恢复为新修订",async()=>{
            if(!window.confirm(`将修订 ${snapshot.revision} 恢复为新的工作草稿？当前草稿会保留为快照。`))return;
            await api(`/creator/projects/${projectId}/draft-restores`,"POST",{expectedRevision:workspace.workspaceRevision,snapshotId:snapshot.id});await refresh();
          }));draftPanel.append(row);
      }
    }catch(error){draftPanel.append(element("p",message(error)));}
  }
  const lifecycle=panel("版本与作品管理");container.append(lifecycle);
  try{
    const versions=list(await api(`/creator/games/${game.id}/versions`));
    for(const version of versions){
      const row=element("div");row.className="row";
      row.append(element("span",`版本 ${version.number} · ${version.review_status}${version.deleted_at?" · 已删除":""}`));
      const actions=element("div");actions.className="actions";
      if(version.deleted_at){
        actions.append(action("恢复版本",async()=>{await api(`/creator/versions/${version.id}/restore`,"POST",{});await refresh();}));
      }else{
        if(projectId)actions.append(action("设为工作基线",async()=>{
          const workspace=await api(`/creator/projects/${projectId}/workspace`);
          await api(`/creator/projects/${projectId}/workspace`,"PATCH",{expectedRevision:workspace.workspaceRevision,baseVersionId:version.id});await refresh();
        }));
        if(version.submission_id)actions.append(action("撤回审核",async()=>{
          await api(`/creator/submissions/${version.submission_id}/withdraw`,"POST",{});await refresh();
        }));
        if(version.review_status==="approved")actions.append(action("发布此版本",async()=>{
          const reason=window.prompt("填写本次发布说明");if(!reason?.trim())return;
          await api(`/creator/games/${game.id}/releases`,"POST",{versionId:version.id,reason:reason.trim()});await refresh();
        }));
        actions.append(action("重新导出",async()=>{
          const job=await api(`/creator/versions/${version.id}/exports`,"POST",{});
          status.textContent=`导出任务已创建：${job.jobId}。可在文件任务中刷新并下载。`;
          await refresh();
        }),action("删除版本",async()=>{
          if(!window.confirm(`删除版本 ${version.number}？30 天内可恢复；被发布、审核、游玩或工作基线引用的版本无法删除。`))return;
          await api(`/creator/versions/${version.id}`,"DELETE");await refresh();
        }));
      }
      row.append(actions);lifecycle.append(row);
    }
    const actions=element("div");actions.className="actions";
    if(game.deleted_at || game.archived_at)actions.append(action("恢复作品",async()=>{
      await api(`/creator/games/${game.id}/restore`,"POST",{});await refresh();
    }));
    else actions.append(action("下架作品",async()=>{
      if(!window.confirm("下架后停止新的游玩入口，现有会话可继续至到期。确认下架？"))return;
      await api(`/creator/games/${game.id}/unpublish`,"POST",{});await refresh();
    }),action("归档作品",async()=>{
      await api(`/creator/games/${game.id}/archive`,"POST",{});await refresh();
    }),action("删除作品",async()=>{
      if(!window.confirm("删除作品后 30 天内可恢复。存在发布、审核、运行会话或未完成任务时会拒绝删除。确认继续？"))return;
      await api(`/creator/games/${game.id}`,"DELETE");await refresh();
    }));
    lifecycle.append(actions);
  }catch(error){lifecycle.append(element("p",message(error)));}
  const artifacts=panel("文件任务与上传恢复");container.append(artifacts);
  artifacts.append(element("p","这里显示当前账号的文件任务。刷新可查询进度；过期或失败的导出可从上方版本重新发起。"));
  artifacts.append(action("刷新文件任务",refresh));
  try{
    const [jobResult,uploadResult]=await Promise.all([api("/creator/artifact-jobs"),api("/creator/uploads")]);
    const jobs=list(jobResult),uploads=list(uploadResult);
    for(const job of jobs){
      const row=element("div");row.className="row";
      row.append(element("span",`${job.kind==="export"?"导出":"上传检查"} · ${job.status} · ${job.id}${job.failureReason?` · ${job.failureReason}`:""}`));
      if(job.kind==="export" && job.status==="succeeded")row.append(action("下载 ZIP",async()=>{
        const grant=await api(`/creator/artifact-jobs/${job.id}/download-grants`,"POST",{});
        const response=await fetch(grant.downloadUrl,{credentials:"same-origin",headers:{"X-Download-Token":grant.token}});
        if(!response.ok){const payload=await response.json().catch(()=>null);throw new Error(payload?.error?.message??"下载失败，请重新获取授权");}
        const url=URL.createObjectURL(await response.blob()),link=element("a");
        link.href=url;link.download=`game-${job.inputId}.zip`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      }));
      artifacts.append(row);
    }
    for(const upload of uploads.filter(item=>["passed","uploaded","pending","failed"].includes(item.status))){
      const row=element("div");row.className="row";
      row.append(element("span",`上传 ${upload.id} · ${upload.status} · ${upload.manifest?.title??""}`));
      if(new Date(upload.expires_at).getTime()<=Date.now())row.append(element("span","上传已过期，请重新上传"));
      else if(upload.status==="passed")row.append(action("用于当前作品的新版本",async()=>{
        if(!window.confirm(`把此上传创建为“${game.title}”的新版本？重复操作会保留独立版本。`))return;
        await api(`/creator/games/${game.id}/versions`,"POST",{uploadId:upload.id});await refresh();
      }));
      else if(upload.status==="uploaded")row.append(action("继续检查",async()=>{
        await api(`/creator/uploads/${upload.id}/complete`,"POST",{});await refresh();
      }));
      else row.append(element("span",upload.failure_reason??"文件尚未完整上传，请重新选择 ZIP 上传。"));
      artifacts.append(row);
    }
    if(!jobs.length && !uploads.length)artifacts.append(element("p","暂无文件任务。"));
  }catch(error){artifacts.append(element("p",message(error)));}
}
