const express=require('express'),cors=require('cors'),jwt=require('jsonwebtoken'),crypto=require('crypto'),{Pool}=require('pg');
const {DATABASE_URL,JWT_SECRET,ADMIN_USER,ADMIN_PASS,PAYSTACK_SECRET_KEY,FRONTEND_URL}=process.env;
const pool=new Pool({connectionString:DATABASE_URL,ssl:DATABASE_URL&&!/localhost|railway\.internal/.test(DATABASE_URL)?{rejectUnauthorized:false}:false});
const CATS=['Bride','Groom','Family','Ministers / Dignitaries','DMC'];
const DEFAULT_ITEMS=[['Aso-ebi: Traditional Marriage',20000],['Aso-ebi: White Wedding',25000],['Groomsmen: Traditional Marriage',30000],['Groomsmen: White Wedding',45000],['DMC Material',15000],['Family Material',18000]].map(([n,p])=>({n,p}));
const app=express();
app.use(cors({origin:FRONTEND_URL?FRONTEND_URL.split(',').map(s=>s.trim()):true}));
app.use('/api/paystack/webhook',express.raw({type:'*/*'}));
app.use('/api/upload',express.raw({type:'image/*',limit:'12mb'}));
app.use(express.json({limit:'2mb'}));
app.use((req,res,next)=>{try{const t=(req.headers.authorization||'').replace('Bearer ','');req.admin=!!(t&&jwt.verify(t,JWT_SECRET).admin)}catch(e){req.admin=false}next()});
const need=(req,res,next)=>req.admin?next():res.status(401).json({error:'Admin login required'});
const ah=f=>(req,res,next)=>f(req,res,next).catch(e=>{console.error(e);res.status(500).json({error:'Server error'})});
const getDoc=async p=>{const r=await pool.query('select data from docs where path=$1',[p]);return r.rows[0]?r.rows[0].data:null};
const putDoc=(p,d)=>pool.query('insert into docs(path,data) values($1,$2) on conflict(path) do update set data=$2,updated_at=now()',[p,d]);
const eq=(a,b)=>crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(),crypto.createHash('sha256').update(String(b)).digest());
app.get('/api/health',(q,r)=>r.json({ok:true}));
app.post('/api/login',(req,res)=>{const{username,password}=req.body||{};
 if(ADMIN_USER&&ADMIN_PASS&&eq(username,ADMIN_USER)&&eq(password,ADMIN_PASS))return res.json({token:jwt.sign({admin:true},JWT_SECRET,{expiresIn:'2h'})});
 setTimeout(()=>res.status(401).json({error:'Wrong username or password.'}),500)});
// documents: site/state (admin writes, public reads without the invite-code list) and guests/<CODE>
app.get('/api/doc/*',ah(async(req,res)=>{const p=req.params[0];
 if(p==='site/state'){const d=await getDoc(p);if(!d)return res.json({exists:false});if(!req.admin){const c={...d};delete c.proposed;return res.json({exists:true,data:c})}return res.json({exists:true,data:d})}
 if(/^guests\/[A-Z0-9-]{3,40}$/.test(p)){const d=await getDoc(p);return res.json(req.admin?{exists:!!d,data:d}:{exists:!!d})}
 res.status(404).json({error:'Not found'})}));
app.put('/api/doc/*',ah(async(req,res)=>{const p=req.params[0],b=req.body||{};
 if(p==='site/state'){if(!req.admin)return res.status(401).json({error:'Admin login required'});await putDoc(p,b);return res.json({ok:true})}
 if(/^guests\/[A-Z0-9-]{3,40}$/.test(p)){const code=p.split('/')[1];
  if(req.admin){await putDoc(p,b);return res.json({ok:true})}
  const st=await getDoc('site/state'),listed=st&&(st.proposed||[]).some(x=>String(x.code).toUpperCase()===code);
  if(!listed)return res.status(404).json({error:'That code isn’t valid. Check your invite card.'});
  if(await getDoc(p))return res.status(409).json({error:'This code has already been used.'});
  const n=String(b.n||'').trim().slice(0,80),cat=CATS.includes(b.cat)?b.cat:null,pic=String(b.pic||'');
  if(!n||!cat||!pic.startsWith('data:image/')||pic.length>80000)return res.status(400).json({error:'Please fill in every field and upload a clear photo.'});
  await putDoc(p,{n,cat,code,pic,ts:Date.now()});return res.json({ok:true})}
 res.status(404).json({error:'Not found'})}));
app.delete('/api/doc/*',need,ah(async(req,res)=>{const p=req.params[0];if(!/^guests\//.test(p))return res.status(400).json({error:'Not allowed'});await pool.query('delete from docs where path=$1',[p]);res.json({ok:true})}));
app.get('/api/col/guests',need,ah(async(req,res)=>{const r=await pool.query("select path,data from docs where path like 'guests/%' order by updated_at");res.json({docs:r.rows.map(x=>({id:x.path.split('/')[1],data:x.data}))})}));
app.get('/api/col/pays',need,ah(async(req,res)=>{const r=await pool.query("select * from pays where status='success' order by id desc");res.json({docs:r.rows.map(x=>({id:String(x.id),data:{item:x.item,price:x.price,name:x.name,phone:x.phone,ts:+new Date(x.created_at)}}))})}));
// uploads (admin) and media (public)
app.post('/api/upload',need,ah(async(req,res)=>{if(!Buffer.isBuffer(req.body)||!req.body.length)return res.status(400).json({error:'No file'});
 const r=await pool.query('insert into media(type,data) values($1,$2) returning id',[req.headers['content-type'],req.body]);res.json({id:r.rows[0].id,url:'/api/media/'+r.rows[0].id})}));
app.get('/api/media/:id',ah(async(req,res)=>{if(!/^[0-9a-f-]{36}$/.test(req.params.id))return res.status(404).end();const r=await pool.query('select type,data from media where id=$1',[req.params.id]);if(!r.rows[0])return res.status(404).end();
 res.set({'Content-Type':r.rows[0].type,'Cache-Control':'public,max-age=31536000,immutable'}).send(r.rows[0].data)}));
// payments (Paystack)
app.post('/api/pay/init',ah(async(req,res)=>{const{item,name,phone}=req.body||{};const st=await getDoc('site/state'),it=((st&&st.items)||DEFAULT_ITEMS).find(x=>x.n===item);
 if(!it||!name||!phone)return res.status(400).json({error:'Missing details'});
 const ref='DMC-'+crypto.randomBytes(6).toString('hex');
 await pool.query('insert into pays(reference,item,price,name,phone) values($1,$2,$3,$4,$5)',[ref,it.n,it.p,String(name).slice(0,80),String(phone).slice(0,30)]);
 const r=await fetch('https://api.paystack.co/transaction/initialize',{method:'POST',headers:{Authorization:'Bearer '+PAYSTACK_SECRET_KEY,'Content-Type':'application/json'},
  body:JSON.stringify({email:String(phone).replace(/\D/g,'')+'@dmclovestory.app',amount:it.p*100,reference:ref,callback_url:(FRONTEND_URL||'').split(',')[0]+'/?paid=1',metadata:{item:it.n,name,phone}})});
 const j=await r.json();if(!j.status)return res.status(502).json({error:j.message||'Paystack error'});res.json({url:j.data.authorization_url})}));
app.post('/api/paystack/webhook',ah(async(req,res)=>{const sig=crypto.createHmac('sha512',PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
 if(sig!==req.headers['x-paystack-signature'])return res.status(401).end();
 const ev=JSON.parse(req.body.toString());if(ev.event==='charge.success')await pool.query("update pays set status='success' where reference=$1",[ev.data.reference]);res.sendStatus(200)}));
(async()=>{await pool.query(`create table if not exists docs(path text primary key,data jsonb not null,updated_at timestamptz default now());
 create table if not exists media(id uuid primary key default gen_random_uuid(),type text,data bytea,created_at timestamptz default now());
 create table if not exists pays(id bigserial primary key,reference text unique,item text,price int,name text,phone text,status text default 'pending',created_at timestamptz default now());`);
 app.listen(process.env.PORT||3000,()=>console.log('API ready'))})().catch(e=>{console.error(e);process.exit(1)});
