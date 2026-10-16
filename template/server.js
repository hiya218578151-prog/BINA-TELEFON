const express=require('express');
const {YemotRouter}=require('yemot-router2');
const {AI_PROVIDER='openai',AI_MODEL,AI_KEY,YEMOT_TOKEN,GEMINI_API_KEY}=process.env;
const SYS='אתה עוזר טלפוני. ענה בעברית, בקצרה (עד 3 משפטים), בלי סימנים מיוחדים ובלי רשימות.';
const geminiKey=GEMINI_API_KEY||(AI_PROVIDER==='gemini'?AI_KEY:'');
async function ask(hist){
 const last=hist.slice(-12);
 let r,j;
 if(AI_PROVIDER==='anthropic'){
  r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':AI_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model:AI_MODEL,max_tokens:300,system:SYS,messages:last})});
  j=await r.json();if(!r.ok)throw new Error(j.error?.message||'Anthropic request failed');return j.content?.[0]?.text;
 }
 if(AI_PROVIDER==='gemini'){
  r=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(AI_MODEL)+':generateContent?key='+encodeURIComponent(AI_KEY),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({systemInstruction:{parts:[{text:SYS}]},contents:last.map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]}))})});
  j=await r.json();if(!r.ok)throw new Error(j.error?.message||'Gemini request failed');return j.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join(' ');
 }
 r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+AI_KEY,'content-type':'application/json'},body:JSON.stringify({model:AI_MODEL,max_tokens:300,messages:[{role:'system',content:SYS},...last]})});
 j=await r.json();if(!r.ok)throw new Error(j.error?.message||'OpenAI request failed');return j.choices?.[0]?.message?.content;
}
async function transcribeFromYemot(ext,fileName){
 if(!YEMOT_TOKEN)throw new Error('YEMOT_TOKEN is missing');
 if(!geminiKey)throw new Error('GEMINI_API_KEY is missing');
 const candidates=['wav','ogg','mp3'];
 let audio=null,mime='';
 for(const extn of candidates){
  const p='ivr2:/'+ext+'/'+fileName+'.'+extn;
  const u=new URL('https://www.call2all.co.il/ym/api/DownloadFile');
  u.searchParams.set('token',YEMOT_TOKEN);u.searchParams.set('path',p);
  const res=await fetch(u,{signal:AbortSignal.timeout(25000)});
  if(!res.ok)continue;
  const buf=Buffer.from(await res.arrayBuffer());
  if(buf.length<128)continue;
  const start=buf.subarray(0,160).toString('utf8').toLowerCase();
  if(start.includes('requested file does not exist')||start.includes('responsestatus')||start.includes('exception'))continue;
  audio=buf;mime=extn==='wav'?'audio/wav':extn==='ogg'?'audio/ogg':'audio/mpeg';break;
 }
 if(!audio)throw new Error('Could not download the caller recording from Yemot');
 if(audio.length>19*1024*1024)throw new Error('Recording is too large for inline Gemini audio');
 const url='https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(process.env.TRANSCRIBE_MODEL||'gemini-3.8-flash')+':generateContent?key='+encodeURIComponent(geminiKey);
 const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(60000),body:JSON.stringify({contents:[{role:'user',parts:[{text:'תמלל במדויק את כל הדיבור בהקלטה. השפה העיקרית היא עברית. החזר רק את התמלול עצמו, בלי הסברים ובלי סימני ציטוט.'},{inlineData:{mimeType:mime,data:audio.toString('base64')}}]}],generationConfig:{temperature:0}})});
 const data=await res.json();
 if(!res.ok)throw new Error('Gemini transcription failed: '+(data.error?.message||res.status));
 const transcript=(data.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join(' ').trim();
 if(!transcript)throw new Error('Gemini returned an empty transcript');
 return transcript;
}
const clean=t=>String(t||'').replace(/[\r\n*#_]+/g,' ').slice(0,600);
const app=express();app.disable('x-powered-by');
app.get('/health',(q,s)=>s.json({ok:true}));
app.get('/selftest',async(q,s)=>{try{const a=await ask([{role:'user',content:'אמור שלום'}]);s.json({ok:!!a})}catch(e){console.error('AI selftest failed:',e.message);s.status(502).json({ok:false})}});
const router=YemotRouter({printLog:true,timeout:'10m',defaults:{removeInvalidChars:true,read:{stt:{block_typing:undefined}}},uncaughtErrorHandler:async(e,call)=>{console.error('IVR error:',e.message);try{call.id_list_message([{type:'text',data:'מצטערים אירעה תקלה בזיהוי הדיבור. נסו שוב'}])}catch(x){try{call.hangup()}catch(y){}}}});
router.get('/',async call=>{
 const hist=[];let previousAnswer='';
 for(let i=0;i<20;i++){
  let transcript='';
  try{
   const fileName='q'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
   await call.read([{type:'text',data:i===0?'ברוכים הבאים לעוזר הטלפוני. אחרי הצפצוף אמרו את שאלתכם ולאחר מכן הקישו סולמית':previousAnswer+' לשאלה נוספת, אמרו אותה אחרי הצפצוף ולאחר מכן הקישו סולמית'}],'record',{file_name:fileName,no_confirm_menu:true,min_length:1,max_length:20,save_on_hangup:false});
   transcript=await transcribeFromYemot(String(call.extension||'').replace(/\D/g,''),fileName);
  }catch(e){console.error('Recording/transcription failed:',e.message);await call.id_list_message([{type:'text',data:'לא הצלחתי להבין את ההקלטה. נסו שוב בבקשה'}],{prependToNextAction:true});continue}
  if(!transcript||!transcript.trim())continue;
  hist.push({role:'user',content:transcript});
  let a;try{a=await ask(hist)}catch(e){console.error('AI response failed:',e.message)}
  a=clean(a)||'מצטער אירעה שגיאה נסו שוב';hist.push({role:'assistant',content:a});previousAnswer=a;
 }
 call.hangup();
});
app.use('/ivr',router);app.listen(Number(process.env.PORT)||10000,'0.0.0.0');
