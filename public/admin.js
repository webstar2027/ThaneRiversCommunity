const $=s=>document.querySelector(s);
async function api(url,options={}){const res=await fetch(url,{headers:{"Content-Type":"application/json",...(options.headers||{})},...options});const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||"Request failed");return data}
function esc(value){return String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]))}
let messages=[];
async function load(){
  try{
    const me=(await api('/api/me')).user;
    if(!me||!me.is_admin){location.href='/';return}
    $('#adminIdentity').textContent=`Signed in as ${me.name||me.email} · ${me.email}`;
    $('#adminStatus').textContent='Active';
    const [membersData,messagesData]=await Promise.all([api('/api/admin/members'),api('/api/admin/messages')]);
    const members=membersData.members||[];messages=messagesData.messages||[];
    $('#memberCount').textContent=members.length;
    $('#messageCount').textContent=messages.length;
    renderMembers(members);renderMessages();
  }catch(e){$('#adminIdentity').textContent=e.message;$('#adminStatus').textContent='Unavailable'}
}
function renderMembers(members){
  if(!members.length){$('#members').innerHTML='<p class="muted">No members yet.</p>';return}
  $('#members').innerHTML=`<table class="member-table"><thead><tr><th>Name</th><th>Email</th><th>Joined</th><th>Role</th></tr></thead><tbody>${members.map(m=>`<tr><td>${esc(m.name||'—')}</td><td>${esc(m.email)}</td><td>${m.created_at?new Date(m.created_at).toLocaleDateString():'—'}</td><td><span class="badge ${m.is_admin?'admin':''}">${m.is_admin?'Admin':'Member'}</span></td></tr>`).join('')}</tbody></table>`;
}
function renderMessages(){
  if(!messages.length){$('#messages').innerHTML='<p class="muted">No community messages yet.</p>';return}
  $('#messages').innerHTML=messages.map((m,i)=>{const user=m.users||{};return `<article class="msg" data-index="${i}"><div class="msg-head"><div><span class="msg-user">${esc(user.name||user.email||m.user_id)}</span> <span class="msg-role">${esc(m.sender_role)}</span></div><time class="msg-time">${m.created_at?new Date(m.created_at).toLocaleString():''}</time></div><div class="msg-body">${esc(m.body)}</div></article>`}).join('');
  document.querySelectorAll('.msg').forEach(el=>el.addEventListener('click',()=>{document.querySelectorAll('.msg').forEach(x=>x.classList.remove('selected'));el.classList.add('selected');const m=messages[Number(el.dataset.index)];$('#replyUserId').value=m.user_id;$('#replyTo').textContent=(m.users?.name||m.users?.email||m.user_id);$('#replyBody').focus()}));
}
$('#replyForm').addEventListener('submit',async e=>{e.preventDefault();$('#replyMsg').textContent='';const user_id=$('#replyUserId').value,body=$('#replyBody').value.trim();if(!user_id)return $('#replyMsg').textContent='Select a community message first.';try{await api('/api/admin/messages',{method:'POST',body:JSON.stringify({user_id,body})});$('#replyBody').value='';$('#replyMsg').textContent='Reply sent.';await load()}catch(err){$('#replyMsg').textContent=err.message}});
$('#refreshBtn').addEventListener('click',load);
$('#logoutBtn').addEventListener('click',async()=>{await api('/api/logout',{method:'POST'});location.href='/'});
load();
