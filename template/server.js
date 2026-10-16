const express=require('express');
const {YemotRouter}=require('yemot-router2');
const {AI_PROVIDER='openai',AI_MODEL,AI_KEY}=process.env;
const SYS='אתה עוזר טלפוני. ענה בעברית, בקצרה (עד 3 משפטים), בלי סימנים מיוחדים ובלי רשימות.';
async function ask(hist){
 const last=hist.slice(-12);
 let r,j;
 if(AI_PROVIDER==='anthropic'){
  r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':AI_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model:AI_MODEL,max_tokens:300,system:SYS,messages:last})});
  j=await r.json();if(!r.ok)throw new Error(j.error?.message||'Anthropic request failed');return j.content?.[0]?.text;
 }
 if(AI_PROVIDER==='gemini'){
  r=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(AI_MODEL)+':generateContent?key='+encodeURIComponent(AI_KEY), {
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({
      systemInstruction:{parts:[{text:SYS}]},
      contents:last.map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]}))
    })
  });
  j=await r.json();if(!r.ok)throw new Error(j.error?.message||'Gemini request failed');return j.candidates?.[0]?.content?.parts?.[0]?.text;
 }
 r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+AI_KEY,'content-type':'application/json'},body:JSON.stringify({model:AI_MODEL,max_tokens:300,messages:[{role:'system',content:SYS},...last]})});
 j=await r.json();if(!r.ok)throw new Error(j.error?.message||'OpenAI request failed');return j.choices?.[0]?.message?.content;
}
const clean=t=>String(t||'').replace(/[\r\n*#_`]+/g,' ').slice(0,600);
const app=express();app.disable('x-powered-by');
app.get('/health',(q,s)=>s.json({ok:true}));
app.get('/selftest',async(q,s)=>{try{const a=await ask([{role:'user',content:'אמור שלום'}]);s.json({ok:!!a})}catch(e){console.error('AI selftest failed:',e.message);s.status(502).json({ok:false})}});
const router=YemotRouter({printLog:true,timeout:'10m',defaults:{removeInvalidChars:true,read:{stt:{block_typing:undefined}}},uncaughtErrorHandler:async(e,call)=>{console.error(e.message);try{call.hangup()}catch(x){}}});
router.get('/',async call=>{
 const hist=[];let msg=[{type:'text',data:'ברוכים הבאים לעוזר הטלפוני. אחרי ההשמעה אמרו את שאלתכם'}];
 for(let i=0;i<20;i++){
  const q=await call.read(msg,'stt',{use_records_recognition_engine:true,allow_empty:true,empty_val:''});
  if(!q||!String(q).trim())return call.hangup();
  hist.push({role:'user',content:String(q)});
  let a;try{a=await ask(hist)}catch(e){console.error('AI request failed:',e.message)}
  a=clean(a)||'מצטער אירעה שגיאה נסו שוב';hist.push({role:'assistant',content:a});
  msg=[{type:'text',data:a},{type:'text',data:'לשאלה נוספת אמרו אותה עכשיו או נתקו'}];
 }
 call.hangup();
});
app.use('/ivr',router);app.listen(Number(process.env.PORT)||10000,'0.0.0.0');
