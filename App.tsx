import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './lib/supabase';
import * as NavigationBar from 'expo-navigation-bar';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
  Alert, Animated, BackHandler, Dimensions,
  Image, KeyboardAvoidingView, Modal, Platform, Pressable,
  ScrollView, Share,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

// ─── Notifications ────────────────────────────────────────────────────────────
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert:true, shouldShowBanner:true, shouldShowList:true, shouldPlaySound:true, shouldSetBadge:false }),
});
async function ensureNotifChannel() {
  if(Platform.OS!=='android') return;
  await Notifications.setNotificationChannelAsync('bills',{name:'Bill Reminders',importance:Notifications.AndroidImportance.HIGH,vibrationPattern:[0,250,250,250],lightColor:'#FF6B35'});
}
async function scheduleBillNotif(bill:Bill,reminderDays:number|null):Promise<string[]> {
  if(reminderDays===null) return [];
  const ids:string[]=[]; const now=new Date();
  const dueAt=new Date(bill.dueDate+'T09:00:00');
  const trigger=new Date(dueAt); trigger.setDate(trigger.getDate()-reminderDays);
  const amt=`Rs ${Number(bill.amount).toLocaleString()}`;
  if(trigger>now) try{
    const id=await Notifications.scheduleNotificationAsync({content:{title:reminderDays===0?'Bill Due Today!':reminderDays===1?'Bill Due Tomorrow':`Bill Due in ${reminderDays} days`,body:`${bill.name} — ${amt}`,data:{billId:bill.id}},trigger:{date:trigger,channelId:'bills'} as any});
    ids.push(id);
  }catch{}
  return ids;
}
async function cancelBillNotifs(ids:string[]) { for(const id of ids) try{await Notifications.cancelScheduledNotificationAsync(id);}catch{} }

// ─── Types ────────────────────────────────────────────────────────────────────
type Screen   = 'groups'|'dashboard'|'bills'|'detail'|'members'|'activity'|'templates'|'create-group';
type Group    = { id:string; name:string; emoji:string; createdAt:number; memberIds:string[] };
type Member   = { id:string; name:string; groupId:string; isCurrentUser:boolean };
type Assignee = { memberId:string; amount:number; paidAt?:string|null };
type Bill     = { id:string; groupId:string; name:string; type:'fixed'|'variable'|'oneoff'; category?:string; amount:number; dueDate:string; assignedTo:Assignee[]; status:'paid'|'unpaid'|'partial'; paidAt:string|null; paidBy:string|null; createdAt:string; month:string; notifIds?:string[]; reminderDays?:number|null };
type Activity = { id:string; groupId:string; type:'paid'|'added'; text:string; timestamp:number };
type User     = { id:string; name:string };
type Template = { id:string; name:string; category:string; dueDay:number; referenceNo?:string };
type AuthUser = { id:string; email:string; name:string };
type AssigneeInput = { memberId:string; rawValue:string; isPct:boolean };

// ─── Colors ───────────────────────────────────────────────────────────────────
const BG      = '#0F0E17';
const SURFACE = '#1A1927';
const SURF2   = '#222136';
const ACCENT  = '#FF6B35';
const ACCENT2 = '#9B8FF5';
const SUCCESS = '#2DD4A0';
const WARN    = '#F5C542';
const DANGER  = '#FF4D6D';
const TXT     = '#FFFFFE';
const TXT2    = '#A7A5B8';
const MUT     = '#5C5A73';
const BORDER  = 'rgba(155,143,245,0.15)';

const AVATAR_COLORS = [ACCENT,'#9B8FF5',SUCCESS,WARN,DANGER,'#5B8FF9','#E07B9A','#7ECBA1','#F0A050','#8B6FD4'];
const CATEGORIES = ['Electricity','Gas','Internet & Phone','Rent','Society','Subscription','Religious','Other'] as const;
const CAT_TYPE:Record<string,Bill['type']> = {Electricity:'variable',Gas:'variable','Internet & Phone':'fixed',Rent:'fixed',Society:'fixed',Subscription:'fixed',Religious:'oneoff',Other:'variable'};
const GROUP_EMOJIS=['🏠','🏡','🏘','🏢','🏗','🏰','🌻','🌺','🌿','🎋','🌙','☀️','⭐','🌟','🎯','🎪','🏆','🌍','🦋','🌳'];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const uid      = () => Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const todayStr = () => new Date().toISOString().split('T')[0];
const monthStr = () => { const n=new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}`; };
const monthLabel = () => new Date().toLocaleDateString('en-US',{month:'long',year:'numeric'});
const fmtDate  = (d:string) => { try{ return new Date(d+'T00:00:00').toLocaleDateString('en-PK',{day:'numeric',month:'short',year:'numeric'}); }catch{ return d; } };
const fmtTs    = (ts:number) => { const d=(Date.now()-ts)/60000; if(d<1)return'just now'; if(d<60)return`${Math.floor(d)}m ago`; if(d<1440)return`${Math.floor(d/60)}h ago`; if(d<2880)return'yesterday'; return new Date(ts).toLocaleDateString('en-PK',{day:'numeric',month:'short'}); };
const dayKey   = (ts:number) => { const d=new Date(ts),n=new Date(); if(d.toDateString()===n.toDateString())return'Today'; const y=new Date(n);y.setDate(y.getDate()-1); if(d.toDateString()===y.toDateString())return'Yesterday'; return d.toLocaleDateString('en-PK',{day:'numeric',month:'long',year:'numeric'}); };
const aColor   = (name:string) => { let h=0; for(const c of name) h=(h*31+c.charCodeAt(0))&0xffffffff; return AVATAR_COLORS[Math.abs(h)%AVATAR_COLORS.length]; };
const calcDueDate = (dueDay:number) => { const n=new Date(),y=n.getFullYear(),mo=n.getMonth()+1,mx=new Date(y,mo,0).getDate(),d=Math.min(dueDay,mx); return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`; };
const getAssigneeAmt = (inp:AssigneeInput, total:number) => { const v=parseFloat(inp.rawValue)||0; return inp.isPct?Math.round(v/100*total*100)/100:v; };

const billStatus = (b:Bill):'paid'|'partial'|'overdue'|'due-soon'|'unpaid' => {
  const ass=b.assignedTo??[];
  if(ass.length>0){ const pc=ass.filter(a=>a.paidAt).length; if(pc===ass.length)return'paid'; if(pc>0)return'partial'; }
  else if(b.status==='paid') return'paid';
  const diff=(new Date(b.dueDate+'T00:00:00').getTime()-new Date(todayStr()+'T00:00:00').getTime())/86400000;
  if(diff<0)return'overdue'; if(diff<=3)return'due-soon'; return'unpaid';
};

// ─── Storage ──────────────────────────────────────────────────────────────────
const K = {done:'finly_onboarded',user:'finly_user',groups:'finly_groups',members:'finly_members',bills:'finly_bills',activity:'finly_activity',templates:'finly_templates'};
const PROXY_URL = 'https://finly-proxy.onrender.com';
const save = (k:string,v:unknown) => AsyncStorage.setItem(k,JSON.stringify(v));
const load = async <T,>(k:string):Promise<T|null> => { try{ const v=await AsyncStorage.getItem(k); return v?JSON.parse(v):null; }catch{ return null; } };

const normalizeBills = (bills:any[]):Bill[] => bills.map(b=>({
  ...b,
  assignedTo:(b.assignedTo??[]).map((a:any)=>typeof a==='string'?{memberId:a,amount:b.amount??0,paidAt:null}:a),
  status:b.status??'unpaid', reminderDays:b.reminderDays??null,
}));

// ─── Supabase sync helpers (fire-and-forget) ─────────────────────────────────
function sbUpsertGroups(groups:Group[],userId:string){
  supabase.from('groups').upsert(groups.map(g=>({id:g.id,name:g.name,emoji:g.emoji,owner_id:userId}))).then(()=>{
    supabase.from('group_users').upsert(groups.map(g=>({group_id:g.id,user_id:userId})),{ignoreDuplicates:true}).then(()=>{});
  });
}
function sbUpsertMembers(members:Member[],userId:string){
  supabase.from('members').upsert(members.map(m=>({id:m.id,group_id:m.groupId,name:m.name,user_id:m.isCurrentUser?userId:null,is_current_user:m.isCurrentUser}))).then(()=>{});
}
function sbUpsertBills(bills:Bill[]){
  supabase.from('bills').upsert(bills.map(b=>({id:b.id,group_id:b.groupId,name:b.name,type:b.type,category:b.category,amount:b.amount,due_date:b.dueDate,month:b.month,status:b.status,paid_at:b.paidAt,paid_by:b.paidBy,created_at:b.createdAt,reminder_days:b.reminderDays,assigned_to:b.assignedTo,notif_ids:b.notifIds??[]}))).then(()=>{});
}
function sbUpsertActivity(activity:Activity[]){
  supabase.from('activity').upsert(activity.map(a=>({id:a.id,group_id:a.groupId,type:a.type,text:a.text,timestamp:a.timestamp})),{ignoreDuplicates:true}).then(()=>{});
}
function sbUpsertTemplates(templates:Template[],userId:string){
  supabase.from('templates').upsert(templates.map(t=>({id:t.id,user_id:userId,name:t.name,category:t.category,due_day:t.dueDay,reference_no:t.referenceNo??''}))).then(()=>{});
}
function sbDeleteBill(id:string){ supabase.from('bills').delete().eq('id',id).then(()=>{}); }
function sbDeleteTemplate(id:string){ supabase.from('templates').delete().eq('id',id).then(()=>{}); }

async function ensureTemplates():Promise<Template[]> {
  let t=await load<Template[]>(K.templates);
  if(!t){ t=[{id:'t1',name:'LESCO',category:'Electricity',dueDay:25,referenceNo:''},{id:'t2',name:'SNGPL',category:'Gas',dueDay:28,referenceNo:''},{id:'t3',name:'PTCL',category:'Internet & Phone',dueDay:15,referenceNo:''},{id:'t4',name:'Rent',category:'Rent',dueDay:1,referenceNo:''}]; await save(K.templates,t); }
  return t;
}

async function seedIfEmpty() {
  if(await load(K.done)) return;
  const n=new Date(),y=n.getFullYear(),mo=String(n.getMonth()+1).padStart(2,'0');
  const dd=(d:number)=>`${y}-${mo}-${String(d).padStart(2,'0')}`;
  const off=(days:number)=>{ const x=new Date(n);x.setDate(x.getDate()+days);return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`; };
  const mStr=monthStr();
  await save(K.groups,[{id:'g1',name:'Al-Malik Home',emoji:'🏠',createdAt:Date.now(),memberIds:['m1','m2','m3','m4']}]);
  await save(K.members,[{id:'m1',name:'Zuhair',groupId:'g1',isCurrentUser:true},{id:'m2',name:'Ahmed',groupId:'g1',isCurrentUser:false},{id:'m3',name:'Sara',groupId:'g1',isCurrentUser:false},{id:'m4',name:'Ammi',groupId:'g1',isCurrentUser:false}]);
  await save(K.bills,[
    {id:'b1',groupId:'g1',name:'LESCO',type:'variable',category:'Electricity',amount:9200,dueDate:off(-3),assignedTo:[{memberId:'m1',amount:9200,paidAt:null}],status:'unpaid',paidAt:null,paidBy:null,createdAt:dd(1),month:mStr,reminderDays:3},
    {id:'b2',groupId:'g1',name:'SNGPL',type:'variable',category:'Gas',amount:3800,dueDate:off(2),assignedTo:[{memberId:'m2',amount:3800,paidAt:null}],status:'unpaid',paidAt:null,paidBy:null,createdAt:dd(1),month:mStr,reminderDays:3},
    {id:'b3',groupId:'g1',name:'Society Fee',type:'fixed',category:'Society',amount:5000,dueDate:dd(10),assignedTo:[{memberId:'m1',amount:2500,paidAt:dd(5)},{memberId:'m2',amount:2500,paidAt:dd(5)}],status:'paid',paidAt:dd(5),paidBy:'m1',createdAt:dd(1),month:mStr,reminderDays:1},
    {id:'b4',groupId:'g1',name:'PTCL',type:'fixed',category:'Internet & Phone',amount:1800,dueDate:dd(15),assignedTo:[{memberId:'m3',amount:1800,paidAt:dd(12)}],status:'paid',paidAt:dd(12),paidBy:'m3',createdAt:dd(1),month:mStr,reminderDays:3},
    {id:'b5',groupId:'g1',name:'Zakat',type:'oneoff',category:'Religious',amount:25000,dueDate:dd(28),assignedTo:[{memberId:'m1',amount:12500,paidAt:null},{memberId:'m4',amount:12500,paidAt:null}],status:'unpaid',paidAt:null,paidBy:null,createdAt:dd(1),month:mStr,reminderDays:7},
  ]);
  await save(K.activity,[
    {id:'a1',groupId:'g1',type:'paid',text:'Sara marked PTCL as paid — Rs 1,800',timestamp:Date.now()-86400000*2},
    {id:'a2',groupId:'g1',type:'paid',text:'Zuhair marked Society Fee as paid — Rs 5,000',timestamp:Date.now()-86400000*5},
    {id:'a3',groupId:'g1',type:'added',text:'Zuhair added LESCO — Rs 9,200',timestamp:Date.now()-86400000*7},
    {id:'a4',groupId:'g1',type:'added',text:'Zuhair added SNGPL — Rs 3,800',timestamp:Date.now()-86400000*7},
    {id:'a5',groupId:'g1',type:'added',text:'Zuhair added Society Fee — Rs 5,000',timestamp:Date.now()-86400000*8},
  ]);
}

// ─── Logo Mark ────────────────────────────────────────────────────────────────
function FinlyMark({size=36,bg=ACCENT}:{size?:number;bg?:string}) {
  const u=size/36;
  return (
    <View style={{width:size,height:size,borderRadius:size*0.25,backgroundColor:bg,overflow:'hidden'}}>
      {/* Vertical stroke of F */}
      <View style={{position:'absolute',left:Math.round(8*u),top:Math.round(6*u),width:Math.round(5*u),height:Math.round(24*u),backgroundColor:'white'}}/>
      {/* Top horizontal bar */}
      <View style={{position:'absolute',left:Math.round(8*u),top:Math.round(6*u),width:Math.round(16*u),height:Math.round(5*u),backgroundColor:'white'}}/>
      {/* Checkmark as middle bar */}
      <Text style={{position:'absolute',left:Math.round(10*u),top:Math.round(13*u),color:'white',fontSize:Math.round(12*u),fontWeight:'900',lineHeight:Math.round(14*u)}}>✓</Text>
    </View>
  );
}

// ─── Badge ────────────────────────────────────────────────────────────────────
function Badge({status}:{status:'paid'|'partial'|'overdue'|'due-soon'|'unpaid'|'clear'}) {
  const map:Record<string,{label:string;color:string;bg:string}> = {
    paid:     {label:'PAID',    color:SUCCESS,  bg:`${SUCCESS}22`},
    clear:    {label:'CLEAR',   color:SUCCESS,  bg:`${SUCCESS}22`},
    partial:  {label:'PARTIAL', color:WARN,     bg:`${WARN}22`},
    overdue:  {label:'OVERDUE', color:DANGER,   bg:`${DANGER}22`},
    'due-soon':{label:'DUE SOON',color:WARN,    bg:`${WARN}22`},
    unpaid:   {label:'UPCOMING',color:TXT2,     bg:`${MUT}33`},
  };
  const st=map[status]??map.unpaid;
  return <View style={{backgroundColor:st.bg,paddingHorizontal:10,paddingVertical:3,borderRadius:20}}><Text style={{color:st.color,fontSize:10,fontWeight:'700',letterSpacing:0.8}}>{st.label}</Text></View>;
}

// ─── Avatar ───────────────────────────────────────────────────────────────────
function Avatar({name,size=44}:{name:string;size?:number}) {
  return <View style={{width:size,height:size,borderRadius:size/2,backgroundColor:aColor(name),alignItems:'center',justifyContent:'center'}}><Text style={{color:'white',fontSize:size*0.38,fontWeight:'700'}}>{(name[0]??'?').toUpperCase()}</Text></View>;
}

// ─── Bill Card ────────────────────────────────────────────────────────────────
function BillCard({bill,members,onPress,myMemberId}:{bill:Bill;members:Member[];onPress:()=>void;myMemberId?:string}) {
  const st=billStatus(bill);
  const myAss=myMemberId?bill.assignedTo.find(a=>a.memberId===myMemberId):null;
  const displayAmt=myAss?myAss.amount:bill.amount;
  const names=bill.assignedTo.map(a=>members.find(m=>m.id===a.memberId)?.name).filter(Boolean) as string[];
  const pill=names.length?names.slice(0,2).join(', ')+(names.length>2?` +${names.length-2}`:''): null;
  const accentBar:Record<string,string>={paid:SUCCESS,partial:WARN,overdue:DANGER,'due-soon':WARN,unpaid:MUT};
  return (
    <TouchableOpacity style={[s.card,{borderLeftWidth:3,borderLeftColor:accentBar[st]??MUT}]} onPress={onPress} activeOpacity={0.75}>
      <View style={{flex:1}}>
        <Text style={s.cardName} numberOfLines={1}>{bill.name}</Text>
        <View style={{flexDirection:'row',alignItems:'center',gap:6,marginTop:5,flexWrap:'wrap'}}>
          <Text style={s.cardMeta}>Due {fmtDate(bill.dueDate)}</Text>
          {pill&&<View style={s.apill}><Text style={s.apillTxt}>{pill}</Text></View>}
        </View>
      </View>
      <View style={{alignItems:'flex-end',gap:4}}>
        <Text style={s.cardAmt}>Rs {Number(displayAmt).toLocaleString()}</Text>
        {myAss&&displayAmt!==bill.amount&&<Text style={{fontSize:10,color:ACCENT2}}>Your share</Text>}
        <Badge status={st}/>
      </View>
    </TouchableOpacity>
  );
}

// ─── Date Picker ──────────────────────────────────────────────────────────────
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function DatePicker({value,onChange}:{value:string;onChange:(d:string)=>void}) {
  const parse=(v:string)=>{ const[y,m,d]=(v||todayStr()).split('-').map(Number);return{year:y,month:m,day:d}; };
  const p=parse(value);
  const[year,setYear]=useState(p.year);const[month,setMonth]=useState(p.month);const[day,setDay]=useState(p.day);const[show,setShow]=useState(false);
  const dim=new Date(year,month,0).getDate();
  const open=()=>{ const pp=parse(value);setYear(pp.year);setMonth(pp.month);setDay(Math.min(pp.day,new Date(pp.year,pp.month,0).getDate()));setShow(true); };
  const confirm=()=>{ const d=Math.min(day,new Date(year,month,0).getDate());onChange(`${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`);setShow(false); };
  function Stepper({label,onDec,onInc}:{label:string;onDec:()=>void;onInc:()=>void}) {
    return <View style={{alignItems:'center',flex:1}}><TouchableOpacity onPress={onInc} style={{padding:10}}><Text style={{fontSize:18,color:ACCENT}}>▲</Text></TouchableOpacity><Text style={{fontSize:17,fontWeight:'600',color:TXT,paddingVertical:6}}>{label}</Text><TouchableOpacity onPress={onDec} style={{padding:10}}><Text style={{fontSize:18,color:ACCENT}}>▼</Text></TouchableOpacity></View>;
  }
  return <>
    <TouchableOpacity style={s.fi} onPress={open}><Text style={{fontSize:15,color:value?TXT:MUT}}>{value?fmtDate(value):'Select date'}</Text></TouchableOpacity>
    <Modal visible={show} transparent animationType="slide" onRequestClose={()=>setShow(false)}>
      <View style={s.sheetOverlay}><View style={s.sheet}><View style={s.shHandle}/><Text style={[s.shTitle,{padding:20,paddingBottom:4}]}>Due Date</Text><View style={{flexDirection:'row',paddingVertical:8}}><Stepper label={String(day)} onDec={()=>setDay(d=>Math.max(1,d-1))} onInc={()=>setDay(d=>Math.min(dim,d+1))}/><Stepper label={MONTHS[month-1]} onDec={()=>setMonth(m=>m===1?12:m-1)} onInc={()=>setMonth(m=>m===12?1:m+1)}/><Stepper label={String(year)} onDec={()=>setYear(y=>y-1)} onInc={()=>setYear(y=>y+1)}/></View><View style={s.moBtns}><TouchableOpacity style={s.btnCan} onPress={()=>setShow(false)}><Text style={{color:TXT2,fontWeight:'500'}}>Cancel</Text></TouchableOpacity><TouchableOpacity style={s.btnOk} onPress={confirm}><Text style={{color:'white',fontWeight:'600'}}>Done</Text></TouchableOpacity></View></View></View>
    </Modal>
  </>;
}

// ─── Bottom Nav ───────────────────────────────────────────────────────────────
function BottomNav({active,onPress}:{active:Screen;onPress:(s:Screen)=>void}) {
  const ins=useSafeAreaInsets();
  const ic=(sc:Screen)=>active===sc?ACCENT:MUT;
  const lc=(sc:Screen)=>({color:active===sc?ACCENT:MUT});
  const HomeIcon=({c}:{c:string})=><View style={{gap:3}}>{[[0,1],[2,3]].map((r,ri)=><View key={ri} style={{flexDirection:'row',gap:3}}>{r.map(i=><View key={i} style={{width:8,height:8,borderRadius:2,backgroundColor:c}}/>)}</View>)}</View>;
  const BillsIcon=({c}:{c:string})=><View style={{gap:3.5,width:20}}>{[20,20,14].map((w,i)=><View key={i} style={{height:2,borderRadius:1,backgroundColor:c,width:w}}/>)}</View>;
  const MembersIcon=({c}:{c:string})=><View style={{alignItems:'center',gap:2}}><View style={{width:10,height:10,borderRadius:5,backgroundColor:c}}/><View style={{flexDirection:'row',gap:3}}><View style={{width:7,height:7,borderRadius:3.5,backgroundColor:c}}/><View style={{width:7,height:7,borderRadius:3.5,backgroundColor:c}}/></View></View>;
  const ActIcon=({c}:{c:string})=><View style={{flexDirection:'row',alignItems:'center'}}>{[4,10,4,10,4].map((h,i)=><View key={i} style={{width:4,height:h,backgroundColor:c,borderRadius:2,marginHorizontal:1}}/>)}</View>;
  return (
    <View style={[s.nav,{paddingBottom:Math.max(ins.bottom,8)}]}>
      <TouchableOpacity style={s.navI} onPress={()=>onPress('dashboard')}><HomeIcon c={ic('dashboard')}/><Text style={[s.navL,lc('dashboard')]}>Home</Text></TouchableOpacity>
      <TouchableOpacity style={s.navI} onPress={()=>onPress('bills')}><BillsIcon c={ic('bills')}/><Text style={[s.navL,lc('bills')]}>Bills</Text></TouchableOpacity>
      <TouchableOpacity style={s.fab} onPress={()=>onPress('add' as any)}><Text style={{color:'white',fontSize:30,lineHeight:34}}>+</Text></TouchableOpacity>
      <TouchableOpacity style={s.navI} onPress={()=>onPress('members')}><MembersIcon c={ic('members')}/><Text style={[s.navL,lc('members')]}>Members</Text></TouchableOpacity>
      <TouchableOpacity style={s.navI} onPress={()=>onPress('activity')}><ActIcon c={ic('activity')}/><Text style={[s.navL,lc('activity')]}>Activity</Text></TouchableOpacity>
    </View>
  );
}

// ─── Profile Modal ────────────────────────────────────────────────────────────
function ProfileModal({visible,user,email,onClose,onRename,onReset,onSignOut}:{visible:boolean;user:User|null;email?:string;onClose:()=>void;onRename:(n:string)=>void;onReset:()=>void;onSignOut:()=>void}) {
  const[editing,setEditing]=useState(false);const[name,setName]=useState(user?.name??'');
  useEffect(()=>{ if(visible){setName(user?.name??'');setEditing(false);} },[visible,user]);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={{flex:1,backgroundColor:'rgba(0,0,0,0.6)'}} activeOpacity={1} onPress={onClose}/>
      <View style={[s.sheet,{paddingBottom:32}]}><View style={s.shHandle}/>
        <View style={{alignItems:'center',padding:20,paddingBottom:16}}>
          <View style={{width:64,height:64,borderRadius:32,backgroundColor:ACCENT,alignItems:'center',justifyContent:'center',marginBottom:12}}><Text style={{color:'white',fontSize:28,fontWeight:'700'}}>{(user?.name?.[0]??'?').toUpperCase()}</Text></View>
          {editing?(
            <View style={{flexDirection:'row',gap:8,width:'100%'}}><TextInput style={[s.fi,{flex:1}]} value={name} onChangeText={setName} autoFocus returnKeyType="done" onSubmitEditing={()=>{if(name.trim()){onRename(name.trim());setEditing(false);}}}/><TouchableOpacity style={[s.btnOk,{paddingHorizontal:16}]} onPress={()=>{if(name.trim()){onRename(name.trim());setEditing(false);}}}><Text style={{color:'white',fontWeight:'600'}}>Save</Text></TouchableOpacity></View>
          ):(
            <View style={{alignItems:'center',gap:4}}><View style={{flexDirection:'row',alignItems:'center',gap:8}}><Text style={{fontSize:20,fontWeight:'600',color:TXT}}>{user?.name??'User'}</Text><TouchableOpacity onPress={()=>setEditing(true)} style={{padding:4}}><Text style={{fontSize:13,color:ACCENT}}>Edit</Text></TouchableOpacity></View>{email?<Text style={{fontSize:12,color:MUT}}>{email}</Text>:null}</View>
          )}
        </View>
        <View style={{height:1,backgroundColor:BORDER,marginHorizontal:16,marginBottom:4}}/>
        <TouchableOpacity onPress={()=>{onClose();setTimeout(onSignOut,300);}} style={{padding:16}}><Text style={{color:ACCENT2,fontSize:15,textAlign:'center'}}>Sign Out</Text></TouchableOpacity>
        <View style={{height:1,backgroundColor:BORDER,marginHorizontal:16}}/>
        <TouchableOpacity onPress={()=>{onClose();setTimeout(()=>Alert.alert('Reset App','Delete all data and start over?',[{text:'Cancel',style:'cancel'},{text:'Reset',style:'destructive',onPress:onReset}]),300);}} style={{padding:16}}><Text style={{color:DANGER,fontSize:15,textAlign:'center'}}>Reset all data</Text></TouchableOpacity>
      </View>
    </Modal>
  );
}

// ─── Add Bill Sheet ───────────────────────────────────────────────────────────
function AddSheet({visible,members,templates,onClose,onSave,onEditTemplates}:{visible:boolean;members:Member[];templates:Template[];onClose:()=>void;onSave:(b:Bill)=>void;onEditTemplates:()=>void}) {
  const[useTemplate,setUseTemplate]=useState(true);
  const[selectedTpl,setSelectedTpl]=useState<string|null>(null);
  const[name,setName]=useState('');
  const[type,setType]=useState<Bill['type']>('fixed');
  const[category,setCategory]=useState('');
  const[amount,setAmount]=useState('');
  const[date,setDate]=useState(todayStr());
  const[selectedMembers,setSelectedMembers]=useState<string[]>([]);
  const[splitInputs,setSplitInputs]=useState<AssigneeInput[]>([]);
  const[reminderDays,setReminderDays]=useState<number|null>(3);
  // LESCO fetch state
  const[lescoRef,setLescoRef]=useState<string|null>(null);
  const[lescoState,setLescoState]=useState<'idle'|'loading'|'captcha'|'success'|'error'>('idle');
  const[lescoCaptchaImg,setLescoCaptchaImg]=useState<string|null>(null);
  const[lescoSessionId,setLescoSessionId]=useState<string|null>(null);
  const[lescoErr,setLescoErr]=useState('');
  const[captchaCode,setCaptchaCode]=useState('');

  const reset=()=>{ setUseTemplate(true);setSelectedTpl(null);setName('');setType('fixed');setCategory('');setAmount('');setDate(todayStr());setSelectedMembers([]);setSplitInputs([]);setReminderDays(3);setLescoRef(null);setLescoState('idle');setLescoCaptchaImg(null);setLescoSessionId(null);setLescoErr('');setCaptchaCode(''); };
  useEffect(()=>{ if(visible) reset(); },[visible]);

  const applyTemplate=(tpl:Template)=>{
    setSelectedTpl(tpl.id);setName(tpl.name);setType(CAT_TYPE[tpl.category]??'fixed');setCategory(tpl.category);setDate(calcDueDate(tpl.dueDay));
    const ref=tpl.referenceNo?.trim()??'';
    if(tpl.category==='Electricity'&&ref.length>0){
      setLescoRef(ref);setLescoState('idle');setLescoErr('');setLescoCaptchaImg(null);setCaptchaCode('');
    } else { setLescoRef(null);setLescoState('idle'); }
  };

  // Parse bill amount/details from raw PITC HTML using text scan (no cheerio needed)
  const parsePitcHtml=(html:string)=>{
    const txt=html.replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/\s+/g,' ');
    const after=(label:string)=>{
      const idx=txt.toUpperCase().indexOf(label.toUpperCase());
      if(idx===-1) return null;
      return txt.slice(idx+label.length,idx+label.length+120).trim().split(/\s{2,}/)[0].trim()||null;
    };
    const parseAmt=(v:string|null)=>parseInt((v||'').replace(/[^0-9]/g,''),10)||0;
    const get=(...labels:string[])=>{ for(const l of labels){const v=after(l);if(v&&v.length<80)return v;} return null; };
    return {
      customerName:        get('CUSTOMER NAME:','CONSUMER NAME:','NAME:')??'Unknown',
      dueDate:             get('DUE DATE:','LAST DATE:','PAYABLE DATE:')??'Unknown',
      amountWithinDueDate: parseAmt(get('AMOUNT PAYABLE WITHIN DUE DATE:','WITHIN DUE DATE:','AMOUNT PAYABLE:')),
      amountAfterDueDate:  parseAmt(get('AMOUNT PAYABLE AFTER DUE DATE:','AFTER DUE DATE:')),
      lastBillMonth:       get('BILL MONTH:','BILLING MONTH:','MONTH:')??'Unknown',
    };
  };

  const lescoFetch=async()=>{
    if(!lescoRef) return;
    setLescoState('loading');setLescoErr('');
    try{
      // Call PITC directly from the device — phone has a Pakistani IP so no blocking.
      // React Native fetch has no CORS restrictions (browser-only concern).
      const parts=lescoRef.split('-');
      const refno=parts.slice(0,3).join(''); // "06-11224-0150112-U" → "06112240150112"
      const res=await fetch(`https://bill.pitc.com.pk/lescobill/general?refno=${refno}`,{
        headers:{'User-Agent':'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36','Accept':'text/html,*/*'},
      });
      if(!res.ok){setLescoState('error');setLescoErr(`PITC returned ${res.status}. Try again later.`);return;}
      const html=await res.text();
      const upper=html.toUpperCase();
      if(upper.includes('NO RECORD')||upper.includes('NOT FOUND')||upper.includes('INVALID REF')){
        setLescoState('error');setLescoErr('Reference number not found on LESCO. Check the number in your template.');return;
      }
      if(!upper.includes('AMOUNT')&&!upper.includes('CUSTOMER')&&!upper.includes('CONSUMER')){
        setLescoState('error');setLescoErr("Couldn't read bill data. Try again or enter the amount manually.");return;
      }
      const data=parsePitcHtml(html);
      if(!data.amountWithinDueDate){setLescoState('error');setLescoErr("Bill found but couldn't read the amount. Enter it manually.");return;}
      fillLescoData(data);
    }catch(e){setLescoState('error');setLescoErr("Couldn't reach PITC bill portal. Check your internet connection.");}
  };

  // Legacy stubs — kept so CAPTCHA UI doesn't crash if somehow shown
  const lescoCaptchaSubmit=async()=>{ setLescoState('idle'); };
  const lescoReloadCaptcha=async()=>{ await lescoFetch(); };

  const fillLescoData=(data:any)=>{
    if(data.amountWithinDueDate) setAmount(String(data.amountWithinDueDate));
    setLescoState('success');
  };

  useEffect(()=>{
    setSplitInputs(prev=>{
      const kept=prev.filter(i=>selectedMembers.includes(i.memberId));
      const existIds=kept.map(i=>i.memberId);
      const totalNum=parseFloat(amount)||0;
      const newEntries=selectedMembers.filter(id=>!existIds.includes(id)).map(id=>({memberId:id,rawValue:selectedMembers.length===1&&totalNum>0?String(totalNum):'',isPct:false}));
      const result=[...kept,...newEntries];
      if(result.length===1&&totalNum>0&&!result[0].rawValue) result[0]={...result[0],rawValue:String(totalNum)};
      return result;
    });
  },[selectedMembers]);

  useEffect(()=>{
    if(selectedMembers.length===1&&splitInputs.length===1){
      const t=parseFloat(amount)||0;
      if(t>0) setSplitInputs([{...splitInputs[0],rawValue:String(t)}]);
    }
  },[amount]);

  const toggleMember=(id:string)=>setSelectedMembers(prev=>prev.includes(id)?prev.filter(x=>x!==id):[...prev,id]);
  const togglePct=(memberId:string)=>{
    const totalNum=parseFloat(amount)||0;
    setSplitInputs(prev=>prev.map(inp=>{
      if(inp.memberId!==memberId) return inp;
      if(!inp.isPct){ const a=parseFloat(inp.rawValue)||0; const pct=totalNum>0?Math.round(a/totalNum*10000)/100:0; return{...inp,isPct:true,rawValue:String(pct)}; }
      else{ const pct=parseFloat(inp.rawValue)||0; const a=Math.round(pct/100*totalNum*100)/100; return{...inp,isPct:false,rawValue:String(a)}; }
    }));
  };
  const splitEqually=()=>{
    const t=parseFloat(amount)||0; if(t<=0||!selectedMembers.length) return;
    const share=Math.floor(t/selectedMembers.length*100)/100;
    const last=Math.round((t-share*(selectedMembers.length-1))*100)/100;
    setSplitInputs(prev=>prev.map((inp,i)=>({...inp,isPct:false,rawValue:String(i===selectedMembers.length-1?last:share)})));
  };

  const totalNum=parseFloat(amount)||0;
  const assignedTotal=splitInputs.reduce((sum,inp)=>sum+getAssigneeAmt(inp,totalNum),0);
  const remaining=Math.round((totalNum-assignedTotal)*100)/100;
  const splitOk=selectedMembers.length===0||Math.abs(remaining)<0.01;

  const doSave=()=>{
    if(!name.trim()){Alert.alert('Enter a bill name');return;}
    if(!amount||isNaN(+amount)||+amount<=0){Alert.alert('Enter a valid amount');return;}
    if(selectedMembers.length>0&&!splitOk){Alert.alert('Split amounts must equal the bill total',`Rs ${Math.abs(remaining).toLocaleString()} ${remaining>0?'unassigned':'over total'}`);return;}
    const assignedTo:Assignee[]=splitInputs.map(inp=>({memberId:inp.memberId,amount:getAssigneeAmt(inp,totalNum),paidAt:null}));
    onSave({id:uid(),groupId:'',name:name.trim(),type,category,amount:totalNum,dueDate:date,assignedTo,status:'unpaid',paidAt:null,paidBy:null,createdAt:todayStr(),month:date.slice(0,7),reminderDays});
  };

  const REMINDER_OPTS:[number|null,string][]=[[null,'None'],[0,'Due date'],[1,'1 day'],[3,'3 days'],[7,'7 days']];
  const tLabels:{[k in Bill['type']]:string}={fixed:'Fixed',variable:'Variable',oneoff:'One-off'};

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==='ios'?'padding':'height'}>
        <TouchableOpacity style={{flex:1,backgroundColor:'rgba(0,0,0,0.6)'}} activeOpacity={1} onPress={onClose}/>
        <View style={s.sheet}>
          <View style={s.shHandle}/>
          <View style={s.shHdr}><Text style={s.shTitle}>Add Bill</Text><TouchableOpacity onPress={onClose}><Text style={{fontSize:24,color:MUT,lineHeight:28}}>×</Text></TouchableOpacity></View>
          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{paddingBottom:32}}>
            <View style={[s.ff,{flexDirection:'row',gap:8}]}>
              {([['Use saved bill',true],['Custom',false]] as [string,boolean][]).map(([l,v])=>(
                <TouchableOpacity key={l} style={[s.tab,useTemplate===v&&s.tabOn,{flex:1,paddingVertical:9,alignItems:'center'}]} onPress={()=>setUseTemplate(v)}>
                  <Text style={[s.tabT,useTemplate===v&&s.tabTOn]}>{l}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {useTemplate&&templates.length>0&&(
              <View style={s.ff}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{gap:8,paddingBottom:4}}>
                  {templates.map(tpl=>(
                    <TouchableOpacity key={tpl.id} style={[s.chip,selectedTpl===tpl.id&&s.chipOn,{paddingHorizontal:14,paddingVertical:9}]} onPress={()=>applyTemplate(tpl)}>
                      <Text style={[s.chipT,selectedTpl===tpl.id&&s.chipTOn,{fontWeight:'500'}]}>{tpl.name}</Text>
                      {tpl.category?<Text style={[{fontSize:10,marginTop:1},selectedTpl===tpl.id?{color:'rgba(255,255,255,0.6)'}:{color:MUT}]}>{tpl.category}</Text>:null}
                    </TouchableOpacity>
                  ))}
                </ScrollView>
                <TouchableOpacity onPress={()=>{onClose();setTimeout(onEditTemplates,350);}} style={{marginTop:6}}>
                  <Text style={{fontSize:12,color:ACCENT}}>Edit saved bills →</Text>
                </TouchableOpacity>
              </View>
            )}
            {/* LESCO fetch banner (shown when electricity template with ref is selected) */}
            {lescoRef&&(
              <View style={{marginHorizontal:16,marginBottom:16,borderRadius:14,borderWidth:1,borderColor:`${ACCENT}44`,backgroundColor:`${ACCENT}0D`,padding:14}}>
                {lescoState==='idle'&&(
                  <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:10}}>
                    <Text style={{fontSize:13,color:ACCENT,fontWeight:'600',flex:1}}>⚡ Auto-fetch from LESCO</Text>
                    <TouchableOpacity style={{backgroundColor:ACCENT,borderRadius:10,paddingHorizontal:14,paddingVertical:8}} onPress={lescoFetch}>
                      <Text style={{color:'white',fontWeight:'700',fontSize:13}}>Fetch now</Text>
                    </TouchableOpacity>
                  </View>
                )}
                {lescoState==='loading'&&(
                  <Text style={{fontSize:13,color:ACCENT,fontWeight:'500',textAlign:'center'}}>⏳ Connecting to LESCO…</Text>
                )}
                {lescoState==='captcha'&&lescoCaptchaImg&&(
                  <View style={{gap:10}}>
                    <Text style={{fontSize:12,color:TXT2}}>Enter the CAPTCHA code to fetch your bill:</Text>
                    <Image source={{uri:lescoCaptchaImg}} style={{width:'100%',height:64,borderRadius:8,backgroundColor:SURF2}} resizeMode="contain"/>
                    <View style={{flexDirection:'row',gap:8}}>
                      <TextInput style={[s.fi,{flex:1,letterSpacing:4,textAlign:'center',fontWeight:'700'}]} placeholder="CODE" placeholderTextColor={MUT} value={captchaCode} onChangeText={v=>setCaptchaCode(v.toUpperCase())} autoCapitalize="characters" maxLength={10}/>
                      <TouchableOpacity style={{backgroundColor:ACCENT,borderRadius:10,paddingHorizontal:14,justifyContent:'center'}} onPress={lescoCaptchaSubmit}>
                        <Text style={{color:'white',fontWeight:'700',fontSize:15}}>→</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={{backgroundColor:SURF2,borderRadius:10,paddingHorizontal:12,justifyContent:'center',borderWidth:1,borderColor:BORDER}} onPress={lescoReloadCaptcha}>
                        <Text style={{color:TXT2,fontSize:16}}>↺</Text>
                      </TouchableOpacity>
                    </View>
                    <Text style={{fontSize:11,color:MUT}}>Can't read it? Tap ↺ to get a new one.</Text>
                  </View>
                )}
                {lescoState==='success'&&(
                  <View style={{flexDirection:'row',alignItems:'center',gap:10}}>
                    <Text style={{fontSize:22}}>✅</Text>
                    <Text style={{fontSize:13,color:SUCCESS,fontWeight:'600',flex:1}}>Amount filled from LESCO</Text>
                    <TouchableOpacity onPress={()=>{setLescoState('idle');setCaptchaCode('');}}><Text style={{fontSize:12,color:MUT}}>Retry</Text></TouchableOpacity>
                  </View>
                )}
                {lescoState==='error'&&(
                  <View style={{gap:8}}>
                    <Text style={{fontSize:13,color:DANGER,lineHeight:18}}>{lescoErr}</Text>
                    <TouchableOpacity style={{backgroundColor:ACCENT,borderRadius:10,paddingVertical:8,alignItems:'center'}} onPress={()=>{setLescoState('idle');setLescoCaptchaImg(null);setCaptchaCode('');}}>
                      <Text style={{color:'white',fontWeight:'700',fontSize:13}}>Try again</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            )}
            <View style={s.ff}><Text style={s.fl}>Bill Name</Text><TextInput style={s.fi} placeholder="e.g. LESCO, SNGPL, Rent…" placeholderTextColor={MUT} value={name} onChangeText={setName}/></View>
            <View style={s.ff}>
              <Text style={s.fl}>Type</Text>
              <View style={{flexDirection:'row',gap:8}}>
                {(Object.keys(tLabels) as Bill['type'][]).map(k=><TouchableOpacity key={k} style={[s.typeOpt,type===k&&s.typeOptOn]} onPress={()=>setType(k)}><Text style={[s.typeOptT,type===k&&s.typeOptTOn]}>{tLabels[k]}</Text></TouchableOpacity>)}
              </View>
            </View>
            <View style={s.ff}><Text style={s.fl}>Amount (Rs)</Text><TextInput style={s.fi} placeholder="0" placeholderTextColor={MUT} value={amount} onChangeText={setAmount} keyboardType="numeric"/></View>
            <View style={s.ff}><Text style={s.fl}>Due Date</Text><DatePicker value={date} onChange={setDate}/></View>
            <View style={s.ff}>
              <Text style={s.fl}>Assign To</Text>
              <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>
                {members.map(m=><TouchableOpacity key={m.id} style={[s.chip,selectedMembers.includes(m.id)&&s.chipOn]} onPress={()=>toggleMember(m.id)}><Text style={[s.chipT,selectedMembers.includes(m.id)&&s.chipTOn]}>{m.name}</Text></TouchableOpacity>)}
              </View>
            </View>
            {selectedMembers.length>0&&(
              <View style={s.ff}>
                <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                  <Text style={s.fl}>Amounts</Text>
                  {selectedMembers.length>1&&<TouchableOpacity onPress={splitEqually}><Text style={{fontSize:12,color:ACCENT}}>Split equally</Text></TouchableOpacity>}
                </View>
                {splitInputs.map(inp=>{
                  const m=members.find(x=>x.id===inp.memberId);
                  if(!m) return null;
                  const computedAmt=inp.isPct?getAssigneeAmt(inp,totalNum):null;
                  return (
                    <View key={inp.memberId} style={{flexDirection:'row',alignItems:'center',gap:10,marginBottom:10}}>
                      <Avatar name={m.name} size={32}/>
                      <Text style={{fontSize:13,color:TXT,width:60}} numberOfLines={1}>{m.name}</Text>
                      <View style={{flex:1,flexDirection:'row',alignItems:'center',gap:6}}>
                        <Text style={{fontSize:13,color:MUT}}>{inp.isPct?'%':'Rs'}</Text>
                        <TextInput style={[s.fi,{flex:1,paddingVertical:9}]} placeholder="0" placeholderTextColor={MUT} value={inp.rawValue} keyboardType="numeric"
                          onChangeText={v=>setSplitInputs(prev=>prev.map(i=>i.memberId===inp.memberId?{...i,rawValue:v}:i))}/>
                        <TouchableOpacity onPress={()=>togglePct(inp.memberId)} style={{backgroundColor:inp.isPct?ACCENT:SURF2,borderRadius:6,paddingHorizontal:8,paddingVertical:6,borderWidth:0.5,borderColor:inp.isPct?ACCENT:BORDER}}>
                          <Text style={{fontSize:11,color:inp.isPct?'white':MUT,fontWeight:'600'}}>%</Text>
                        </TouchableOpacity>
                      </View>
                      {inp.isPct&&computedAmt!==null&&<Text style={{fontSize:11,color:MUT,minWidth:56,textAlign:'right'}}>Rs {computedAmt.toLocaleString()}</Text>}
                    </View>
                  );
                })}
                {totalNum>0&&(
                  <View style={{backgroundColor:SURF2,borderRadius:10,padding:12,borderWidth:0.5,borderColor:BORDER,gap:3}}>
                    <View style={{flexDirection:'row',justifyContent:'space-between'}}><Text style={{fontSize:12,color:MUT}}>Assigned</Text><Text style={{fontSize:12,fontWeight:'500',color:TXT}}>{`Rs ${assignedTotal.toLocaleString()}`}</Text></View>
                    <View style={{flexDirection:'row',justifyContent:'space-between'}}><Text style={{fontSize:12,color:MUT}}>Bill total</Text><Text style={{fontSize:12,fontWeight:'500',color:TXT}}>{`Rs ${totalNum.toLocaleString()}`}</Text></View>
                    <View style={{height:1,backgroundColor:BORDER,marginVertical:4}}/>
                    {Math.abs(remaining)<0.01
                      ? <Text style={{fontSize:12,color:SUCCESS,fontWeight:'600'}}>Fully assigned ✓</Text>
                      : remaining>0
                        ? <Text style={{fontSize:12,color:WARN,fontWeight:'500'}}>{`Rs ${remaining.toLocaleString()} unassigned`}</Text>
                        : <Text style={{fontSize:12,color:DANGER,fontWeight:'500'}}>{`Rs ${Math.abs(remaining).toLocaleString()} over total`}</Text>}
                  </View>
                )}
              </View>
            )}
            <View style={s.ff}>
              <Text style={s.fl}>Remind assignees</Text>
              <View style={{flexDirection:'row',flexWrap:'wrap',gap:6,marginBottom:6}}>
                {REMINDER_OPTS.map(([v,l])=>(
                  <TouchableOpacity key={String(v)} style={[s.chip,reminderDays===v&&s.chipOn,{paddingVertical:7}]} onPress={()=>setReminderDays(v)}>
                    <Text style={[s.chipT,reminderDays===v&&s.chipTOn]}>{l}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={{fontSize:11,color:MUT}}>Push notifications coming in a future update</Text>
            </View>
            <TouchableOpacity style={[s.btnP,{margin:16}]} onPress={doSave}><Text style={{color:'white',fontWeight:'700',fontSize:15}}>Save Bill</Text></TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ─── Bill Detail ──────────────────────────────────────────────────────────────
function DetailScreen({bill,members,me,onBack,onMarkSharePaid,onDelete}:{bill:Bill;members:Member[];me:Member|undefined;onBack:()=>void;onMarkSharePaid:(memberId:string)=>void;onDelete:()=>void}) {
  const ins=useSafeAreaInsets();
  const st=billStatus(bill);
  const tl={fixed:'Fixed Monthly',variable:'Variable Monthly',oneoff:'One-off'}[bill.type];
  const paidCount=bill.assignedTo.filter(a=>a.paidAt).length;
  const allPaid=paidCount===bill.assignedTo.length&&bill.assignedTo.length>0;
  return (
    <View style={{flex:1,backgroundColor:BG}}>
      <View style={[s.hdr,{paddingTop:ins.top+12}]}>
        <TouchableOpacity onPress={onBack} style={s.backBtn}><Text style={{color:ACCENT2,fontSize:13}}>← Back</Text></TouchableOpacity>
        <Text style={[s.hdrTitle,{fontSize:16}]} numberOfLines={1}>{bill.name}</Text>
      </View>
      <ScrollView contentContainerStyle={{paddingBottom:40}} showsVerticalScrollIndicator={false}>
        <View style={{padding:18,paddingBottom:8,flexDirection:'row',gap:8,alignItems:'center'}}>
          <Badge status={st}/>
          {st==='partial'&&<Text style={{fontSize:12,color:WARN}}>({paidCount} of {bill.assignedTo.length} paid)</Text>}
        </View>
        <Text style={{fontSize:22,fontWeight:'700',color:TXT,paddingHorizontal:16,marginBottom:4}}>{bill.name}</Text>
        <Text style={{fontSize:36,fontWeight:'700',color:TXT,paddingHorizontal:16,marginBottom:18,letterSpacing:-0.5}}>Rs {Number(bill.amount).toLocaleString()}</Text>
        <View style={s.detRows}>
          {([['Type',tl],['Due Date',fmtDate(bill.dueDate)],['Added',fmtDate(bill.createdAt)]] as [string,string][]).map(([l,v])=>(
            <View key={l} style={s.detRow}><Text style={s.drL}>{l}</Text><Text style={s.drV}>{v}</Text></View>
          ))}
        </View>
        {bill.assignedTo.length>0&&(
          <View style={{marginHorizontal:16,marginBottom:16}}>
            <Text style={{fontSize:11,fontWeight:'700',color:MUT,marginBottom:10,textTransform:'uppercase',letterSpacing:0.8}}>Assignees</Text>
            {bill.assignedTo.map(a=>{
              const m=members.find(x=>x.id===a.memberId);
              if(!m) return null;
              const isMyShare=a.memberId===me?.id;
              const isPaid=!!a.paidAt;
              return (
                <View key={a.memberId} style={{backgroundColor:SURFACE,borderRadius:12,borderWidth:1,borderColor:BORDER,padding:12,marginBottom:8,flexDirection:'row',alignItems:'center',gap:12}}>
                  <Avatar name={m.name} size={36}/>
                  <View style={{flex:1}}>
                    <Text style={{fontSize:14,fontWeight:'600',color:TXT}}>{m.name}{isMyShare?<Text style={{fontWeight:'400',color:MUT}}> (you)</Text>:null}</Text>
                    <Text style={{fontSize:13,color:TXT2,marginTop:1}}>Rs {Number(a.amount).toLocaleString()}</Text>
                    {isPaid&&<Text style={{fontSize:11,color:SUCCESS,marginTop:2}}>Paid on {fmtDate(a.paidAt!)}</Text>}
                  </View>
                  {isPaid
                    ? <Badge status="paid"/>
                    : isMyShare
                      ? <TouchableOpacity style={[s.btnGrn,{paddingHorizontal:14,paddingVertical:8,margin:0}]} onPress={()=>Alert.alert('Mark your share as paid?',`Rs ${Number(a.amount).toLocaleString()}`,[{text:'Cancel',style:'cancel'},{text:'Confirm',onPress:()=>onMarkSharePaid(a.memberId)}])}><Text style={{color:'white',fontWeight:'700',fontSize:12}}>Mark paid</Text></TouchableOpacity>
                      : <Badge status="unpaid"/>}
                </View>
              );
            })}
          </View>
        )}
        {bill.assignedTo.length===0&&bill.status!=='paid'&&(
          <TouchableOpacity style={[s.btnGrn,{margin:16}]} onPress={()=>Alert.alert('Mark as Paid?',`Rs ${Number(bill.amount).toLocaleString()}`,[{text:'Cancel',style:'cancel'},{text:'Mark Paid',onPress:()=>onMarkSharePaid('')}])}>
            <Text style={{color:'white',fontWeight:'700',fontSize:15}}>Mark as Paid</Text>
          </TouchableOpacity>
        )}
        {allPaid&&(
          <View style={s.paidBox}><Text style={{color:SUCCESS,fontWeight:'700',fontSize:13,marginBottom:2}}>Fully Paid ✓</Text><Text style={{color:SUCCESS,fontSize:13}}>All shares paid as of {fmtDate(bill.assignedTo[bill.assignedTo.length-1]?.paidAt??todayStr())}</Text></View>
        )}
        <TouchableOpacity onPress={()=>Alert.alert('Delete Bill?',`"${bill.name}" will be permanently removed.`,[{text:'Cancel',style:'cancel'},{text:'Delete',style:'destructive',onPress:onDelete}])}>
          <Text style={{color:DANGER,textAlign:'center',padding:18,fontSize:14}}>Delete Bill</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

// ─── Templates Screen ─────────────────────────────────────────────────────────
function TemplatesScreen({templates,onBack,onSave,onDelete}:{templates:Template[];onBack:()=>void;onSave:(t:Template)=>void;onDelete:(id:string)=>void}) {
  const ins=useSafeAreaInsets();
  const[showSheet,setShowSheet]=useState(false);
  const[editing,setEditing]=useState<Template|null>(null);
  const[tName,setTName]=useState('');const[tCat,setTCat]=useState(CATEGORIES[0] as string);const[tDay,setTDay]=useState('');const[tRef,setTRef]=useState('');
  const openAdd=()=>{ setEditing(null);setTName('');setTCat(CATEGORIES[0]);setTDay('');setTRef('');setShowSheet(true); };
  const openEdit=(t:Template)=>{ setEditing(t);setTName(t.name);setTCat(t.category);setTDay(String(t.dueDay));setTRef(t.referenceNo??'');setShowSheet(true); };
  const doSave=()=>{ if(!tName.trim()||!tDay){Alert.alert('Fill in name and due day');return;} const day=parseInt(tDay); if(isNaN(day)||day<1||day>31){Alert.alert('Due day must be 1–31');return;} onSave({id:editing?.id??uid(),name:tName.trim(),category:tCat,dueDay:day,referenceNo:tRef.trim()});setShowSheet(false); };
  return (
    <View style={{flex:1,backgroundColor:BG}}>
      <View style={[s.hdr,{paddingTop:ins.top+12}]}>
        <TouchableOpacity onPress={onBack} style={s.backBtn}><Text style={{color:ACCENT2,fontSize:13}}>← Back</Text></TouchableOpacity>
        <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center'}}>
          <Text style={s.hdrTitle}>Saved Bills</Text>
          <TouchableOpacity onPress={openAdd} style={{backgroundColor:ACCENT,borderRadius:8,paddingHorizontal:12,paddingVertical:6}}><Text style={{color:'white',fontWeight:'700',fontSize:13}}>+ Add</Text></TouchableOpacity>
        </View>
      </View>
      <ScrollView contentContainerStyle={{padding:16,paddingBottom:40}} showsVerticalScrollIndicator={false}>
        <Text style={{fontSize:13,color:TXT2,marginBottom:16,lineHeight:18}}>Saved bills are templates you can reuse every month. Tap to pre-fill a bill when adding.</Text>
        {templates.map(t=>(
          <View key={t.id} style={[s.card,{flexDirection:'column',alignItems:'stretch',gap:8}]}>
            <View style={{flexDirection:'row',alignItems:'center',gap:10}}>
              <View style={{flex:1}}>
                <Text style={{fontSize:15,fontWeight:'700',color:TXT}}>{t.name}</Text>
                <View style={{flexDirection:'row',alignItems:'center',gap:8,marginTop:4}}>
                  <View style={{backgroundColor:`${ACCENT2}22`,paddingHorizontal:8,paddingVertical:2,borderRadius:10}}><Text style={{color:ACCENT2,fontSize:11,fontWeight:'700',letterSpacing:0.5}}>{t.category}</Text></View>
                  <Text style={{fontSize:12,color:MUT}}>Due {t.dueDay}{t.dueDay===1?'st':t.dueDay===2?'nd':t.dueDay===3?'rd':'th'} of month</Text>
                </View>
                {t.referenceNo?<Text style={{fontSize:11,color:MUT,marginTop:3}}>Ref: {t.referenceNo}</Text>:null}
              </View>
              <TouchableOpacity onPress={()=>openEdit(t)} style={{padding:6}}><Text style={{color:ACCENT,fontSize:13}}>Edit</Text></TouchableOpacity>
              <TouchableOpacity onPress={()=>Alert.alert('Delete Template?',`"${t.name}" will be removed.`,[{text:'Cancel',style:'cancel'},{text:'Delete',style:'destructive',onPress:()=>onDelete(t.id)}])} style={{padding:6}}><Text style={{color:DANGER,fontSize:13}}>Delete</Text></TouchableOpacity>
            </View>
          </View>
        ))}
        {templates.length===0&&<View style={s.empty}><Text style={s.emptyT}>No saved bills yet.{'\n'}Tap + Add to create one.</Text></View>}
      </ScrollView>
      <Modal visible={showSheet} transparent animationType="slide" onRequestClose={()=>setShowSheet(false)}>
        <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==='ios'?'padding':'height'}>
          <TouchableOpacity style={{flex:1,backgroundColor:'rgba(0,0,0,0.6)'}} activeOpacity={1} onPress={()=>setShowSheet(false)}/>
          <View style={s.sheet}>
            <View style={s.shHandle}/>
            <View style={s.shHdr}><Text style={s.shTitle}>{editing?'Edit Template':'New Template'}</Text><TouchableOpacity onPress={()=>setShowSheet(false)}><Text style={{fontSize:24,color:MUT,lineHeight:28}}>×</Text></TouchableOpacity></View>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{padding:16,paddingTop:4,paddingBottom:32}}>
              <Text style={s.fl}>Bill Name</Text><TextInput style={[s.fi,{marginBottom:16}]} placeholder="e.g. LESCO" placeholderTextColor={MUT} value={tName} onChangeText={setTName}/>
              <Text style={s.fl}>Category</Text>
              <View style={{flexDirection:'row',flexWrap:'wrap',gap:6,marginBottom:16}}>
                {CATEGORIES.map(c=><TouchableOpacity key={c} style={[s.chip,tCat===c&&s.chipOn]} onPress={()=>setTCat(c)}><Text style={[s.chipT,tCat===c&&s.chipTOn]}>{c}</Text></TouchableOpacity>)}
              </View>
              <Text style={s.fl}>Due Day of Month (1–31)</Text>
              <TextInput style={[s.fi,{marginBottom:16}]} placeholder="e.g. 25" placeholderTextColor={MUT} value={tDay} onChangeText={v=>setTDay(v.replace(/[^0-9]/g,''))} keyboardType="numeric" maxLength={2}/>
              <Text style={s.fl}>Reference No. <Text style={{fontWeight:'400',color:MUT}}>(optional)</Text></Text>
              <TextInput style={[s.fi,{marginBottom:20}]} placeholder="Optional" placeholderTextColor={MUT} value={tRef} onChangeText={setTRef}/>
              <TouchableOpacity style={s.btnP} onPress={doSave}><Text style={{color:'white',fontWeight:'700',fontSize:15}}>Save Template</Text></TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

// ─── Create Group Screen ──────────────────────────────────────────────────────
function CreateGroupScreen({user,onDone,onBack}:{user:User|null;onDone:(g:Group,members:Member[])=>void;onBack:()=>void}) {
  const ins=useSafeAreaInsets();
  const[phase,setPhase]=useState<'info'|'members'>('info');
  const[groupName,setGroupName]=useState('');
  const[emoji,setEmoji]=useState('🏠');
  const[pendingNames,setPendingNames]=useState<string[]>([]);
  const[newName,setNewName]=useState('');
  const proceed=()=>{ if(!groupName.trim()){Alert.alert('Enter a group name');return;} setPhase('members'); };
  const addMember=()=>{ if(!newName.trim()) return; setPendingNames(prev=>[...prev,newName.trim()]);setNewName(''); };
  const finish=(skip=false)=>{
    const gid=uid();
    const me:Member={id:uid(),name:user?.name??'You',groupId:gid,isCurrentUser:true};
    const extras:Member[]=(skip?[]:pendingNames).map(n=>({id:uid(),name:n,groupId:gid,isCurrentUser:false}));
    const memberIds=[me.id,...extras.map(m=>m.id)];
    const g:Group={id:gid,name:groupName.trim(),emoji,createdAt:Date.now(),memberIds};
    onDone(g,[me,...extras]);
  };
  return (
    <View style={{flex:1,backgroundColor:BG}}>
      <View style={[s.hdr,{paddingTop:ins.top+12}]}>
        <TouchableOpacity onPress={onBack} style={s.backBtn}><Text style={{color:ACCENT2,fontSize:13}}>← Back</Text></TouchableOpacity>
        <Text style={s.hdrTitle}>{phase==='info'?'Create Group':'Add Members'}</Text>
      </View>
      {phase==='info'?(
        <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==='ios'?'padding':'height'}>
          <ScrollView contentContainerStyle={{padding:20,gap:16}} keyboardShouldPersistTaps="handled">
            <View style={s.ff}>
              <Text style={s.fl}>Group Name</Text>
              <TextInput style={s.fi} placeholder="e.g. Al-Malik Home" placeholderTextColor={MUT} value={groupName} onChangeText={setGroupName} autoFocus returnKeyType="done"/>
            </View>
            <View style={s.ff}>
              <Text style={[s.fl,{marginBottom:12}]}>Emoji</Text>
              <View style={{flexDirection:'row',flexWrap:'wrap',gap:10}}>
                {GROUP_EMOJIS.map(em=>(
                  <TouchableOpacity key={em} onPress={()=>setEmoji(em)} style={{width:44,height:44,borderRadius:12,backgroundColor:emoji===em?`${ACCENT}33`:SURFACE,borderWidth:emoji===em?2:1,borderColor:emoji===em?ACCENT:BORDER,alignItems:'center',justifyContent:'center'}}>
                    <Text style={{fontSize:24}}>{em}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
            {groupName.trim()&&(
              <View style={{backgroundColor:SURFACE,borderRadius:14,padding:16,borderWidth:1,borderColor:BORDER,flexDirection:'row',alignItems:'center',gap:12}}>
                <Text style={{fontSize:28}}>{emoji}</Text>
                <Text style={{fontSize:16,fontWeight:'700',color:TXT}}>{groupName}</Text>
              </View>
            )}
            <TouchableOpacity style={[s.btnP,{marginTop:8}]} onPress={proceed}><Text style={{color:'white',fontWeight:'700',fontSize:15}}>Continue</Text></TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      ):(
        <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==='ios'?'padding':'height'}>
          <ScrollView contentContainerStyle={{padding:20}} keyboardShouldPersistTaps="handled">
            <Text style={{fontSize:15,color:TXT2,marginBottom:20}}>Who's in <Text style={{color:TXT,fontWeight:'700'}}>{groupName}</Text>?</Text>
            <View style={[s.mr,{marginHorizontal:0,marginBottom:8}]}><Avatar name={user?.name??'You'}/><View style={{flex:1}}><Text style={s.mrName}>{user?.name??'You'} <Text style={{fontSize:12,color:MUT,fontWeight:'400'}}>(you)</Text></Text></View></View>
            {pendingNames.map((n,i)=>(
              <View key={i} style={[s.mr,{marginHorizontal:0,marginBottom:8}]}>
                <Avatar name={n}/>
                <View style={{flex:1}}><Text style={s.mrName}>{n}</Text></View>
                <TouchableOpacity onPress={()=>setPendingNames(prev=>prev.filter((_,j)=>j!==i))}><Text style={{color:DANGER,fontSize:22,lineHeight:26}}>×</Text></TouchableOpacity>
              </View>
            ))}
            <View style={{flexDirection:'row',gap:8,marginBottom:20,marginTop:4}}>
              <TextInput style={[s.fi,{flex:1}]} placeholder="Add member name…" placeholderTextColor={MUT} value={newName} onChangeText={setNewName} returnKeyType="done" onSubmitEditing={addMember}/>
              <TouchableOpacity style={s.btnOk} onPress={addMember}><Text style={{color:'white',fontWeight:'700'}}>Add</Text></TouchableOpacity>
            </View>
            <TouchableOpacity style={s.btnP} onPress={()=>finish(false)}><Text style={{color:'white',fontWeight:'700',fontSize:15}}>Done — Go to group</Text></TouchableOpacity>
            <TouchableOpacity onPress={()=>finish(true)} style={{padding:16,alignItems:'center'}}><Text style={{color:MUT,fontSize:13}}>Skip for now</Text></TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </View>
  );
}

// ─── Groups Screen ────────────────────────────────────────────────────────────
function GroupsScreen({groups,members,bills,user,onGroup,onCreateGroup,onJoinGroup,onProfile,onSettings,onLogoTap}:{groups:Group[];members:Member[];bills:Bill[];user:User|null;onGroup:(id:string)=>void;onCreateGroup:()=>void;onJoinGroup:()=>void;onProfile:()=>void;onSettings:()=>void;onLogoTap:()=>void}) {
  const ins=useSafeAreaInsets();
  const mo=monthStr();
  return (
    <View style={{flex:1,backgroundColor:BG}}>
      <View style={[s.hdr,{paddingTop:ins.top+12}]}>
        <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between'}}>
          <Pressable style={{flexDirection:'row',alignItems:'center',gap:8}} onPress={onLogoTap}>
            <FinlyMark size={32}/>
            <Text style={{color:TXT,fontSize:20,fontWeight:'700',letterSpacing:0.3}}>Finly</Text>
          </Pressable>
          <View style={{flexDirection:'row',gap:8}}>
            <TouchableOpacity onPress={onSettings} style={{width:36,height:36,borderRadius:18,backgroundColor:SURFACE,borderWidth:1,borderColor:BORDER,alignItems:'center',justifyContent:'center'}} activeOpacity={0.7}><Text style={{fontSize:17}}>⚙</Text></TouchableOpacity>
            <TouchableOpacity onPress={onProfile} style={{width:36,height:36,borderRadius:18,backgroundColor:ACCENT,alignItems:'center',justifyContent:'center'}} activeOpacity={0.7}><Text style={{color:'white',fontSize:15,fontWeight:'700'}}>{(user?.name?.[0]??'?').toUpperCase()}</Text></TouchableOpacity>
          </View>
        </View>
      </View>
      <ScrollView contentContainerStyle={{paddingBottom:20}} showsVerticalScrollIndicator={false}>
        <Text style={s.secTitle}>Your Groups</Text>
        {groups.map(g=>{
          const mems=members.filter(m=>g.memberIds?.includes(m.id));
          const gbs=bills.filter(b=>b.groupId===g.id&&b.month===mo);
          const paid=gbs.filter(b=>billStatus(b)==='paid').length, total=gbs.length;
          const pct=total?Math.round(paid/total*100):0;
          const over=gbs.filter(b=>billStatus(b)==='overdue').length;
          const soon=gbs.filter(b=>billStatus(b)==='due-soon').length;
          const hSt:any=over?'overdue':soon?'due-soon':'clear';
          return (
            <TouchableOpacity key={g.id} style={s.gc} onPress={()=>onGroup(g.id)} activeOpacity={0.75}>
              <View style={{flexDirection:'row',alignItems:'center',gap:12,marginBottom:12}}>
                <Text style={{fontSize:32}}>{g.emoji||'🏠'}</Text>
                <View style={{flex:1}}>
                  <Text style={s.gcName}>{g.name}</Text>
                  <Text style={s.gcSub}>{mems.length} member{mems.length!==1?'s':''} · {total} bill{total!==1?'s':''} this month</Text>
                </View>
                <Badge status={hSt}/>
              </View>
              <View style={{backgroundColor:SURF2,borderRadius:5,height:6,overflow:'hidden',marginBottom:12}}>
                <View style={{height:6,borderRadius:5,backgroundColor:SUCCESS,width:`${pct}%` as any}}/>
              </View>
              <View style={{flexDirection:'row',gap:4}}>
                {mems.slice(0,5).map(m=><View key={m.id} style={{width:28,height:28,borderRadius:14,backgroundColor:aColor(m.name),alignItems:'center',justifyContent:'center'}}><Text style={{color:'white',fontSize:11,fontWeight:'700'}}>{m.name[0].toUpperCase()}</Text></View>)}
              </View>
            </TouchableOpacity>
          );
        })}
        {groups.length===0&&<View style={[s.empty,{paddingVertical:40}]}><Text style={{fontSize:40,marginBottom:12}}>🏠</Text><Text style={s.emptyT}>No groups yet.{'\n'}Create your first household group below.</Text></View>}
      </ScrollView>
      <View style={{backgroundColor:SURFACE,borderTopWidth:1,borderTopColor:BORDER,padding:16,paddingBottom:Math.max(ins.bottom,16)+4,flexDirection:'row',gap:12}}>
        <TouchableOpacity style={[s.btnP,{flex:1,paddingVertical:14}]} onPress={onCreateGroup}><Text style={{color:'white',fontWeight:'700',fontSize:14}}>+ Create group</Text></TouchableOpacity>
        <TouchableOpacity style={[s.btnO,{flex:1,paddingVertical:14}]} onPress={onJoinGroup}><Text style={{color:ACCENT,fontWeight:'700',fontSize:14}}>Join group</Text></TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function DashboardScreen({group,members,bills,tab,onTabChange,onBill,onProfile,onLogoTap}:{group:Group;members:Member[];bills:Bill[];tab:'all'|'mine';onTabChange:(t:'all'|'mine')=>void;onBill:(id:string)=>void;onProfile:()=>void;onLogoTap:()=>void}) {
  const ins=useSafeAreaInsets();
  const me=members.find(m=>m.isCurrentUser);
  const paid=bills.filter(b=>billStatus(b)==='paid').length, total=bills.length;
  const over=bills.filter(b=>billStatus(b)==='overdue').length, out=bills.filter(b=>billStatus(b)!=='paid').length;
  const pct=total?Math.round(paid/total*100):0;
  const shown=tab==='mine'&&me?bills.filter(b=>b.assignedTo.some(a=>a.memberId===me.id)):bills;

  const statCards:[string,number,string,string][]=[
    ['TOTAL BILLS',total,ACCENT,'#FF6B3533'],
    ['PAID',paid,SUCCESS,`${SUCCESS}22`],
    ['OUTSTANDING',out,WARN,`${WARN}22`],
    ['OVERDUE',over,DANGER,`${DANGER}22`],
  ];

  return (
    <View style={{flex:1,backgroundColor:BG}}>
      <View style={[s.hdr,{paddingTop:ins.top+12}]}>
        <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
          <Pressable style={{flexDirection:'row',alignItems:'center',gap:7}} onPress={onLogoTap}>
            <FinlyMark size={24}/>
            <Text style={{color:TXT,fontSize:14,fontWeight:'700',letterSpacing:0.3}}>Finly</Text>
          </Pressable>
          <TouchableOpacity onPress={onProfile} style={{width:32,height:32,borderRadius:16,backgroundColor:ACCENT,alignItems:'center',justifyContent:'center'}} activeOpacity={0.7}><Text style={{color:'white',fontSize:13,fontWeight:'700'}}>{(me?.name?.[0]??'?').toUpperCase()}</Text></TouchableOpacity>
        </View>
        <Text style={s.hdrSub}>{group.name}</Text>
        <Text style={s.hdrTitle}>{monthLabel()}</Text>
      </View>
      <ScrollView contentContainerStyle={{paddingBottom:20}} showsVerticalScrollIndicator={false}>
        <View style={{flexDirection:'row',flexWrap:'wrap',padding:12,paddingBottom:4}}>
          {statCards.map(([l,v,c,bg])=>(
            <View key={l} style={{width:'50%',padding:4}}>
              <View style={[s.statCard,{borderLeftWidth:3,borderLeftColor:c,backgroundColor:SURFACE}]}>
                <Text style={[s.statL,{color:c,letterSpacing:0.8,fontSize:10}]}>{l}</Text>
                <Text style={[s.statV,{color:TXT,fontSize:36}]}>{v}</Text>
              </View>
            </View>
          ))}
        </View>
        <View style={{paddingHorizontal:16,paddingBottom:12}}>
          <View style={{flexDirection:'row',justifyContent:'space-between',marginBottom:8}}>
            <Text style={{fontSize:12,color:TXT2}}>{paid} of {total} paid</Text>
            <Text style={{fontSize:12,fontWeight:'700',color:TXT}}>{pct}%</Text>
          </View>
          <View style={s.progBg}><View style={[s.progFill,{width:`${pct}%` as any}]}/></View>
        </View>
        <View style={{flexDirection:'row',paddingHorizontal:16,paddingBottom:6,gap:8}}>
          {(['all','mine'] as const).map(t=><TouchableOpacity key={t} style={[s.tab,tab===t&&s.tabOn]} onPress={()=>onTabChange(t)}><Text style={[s.tabT,tab===t&&s.tabTOn]}>{t==='all'?'All Bills':'Mine'}</Text></TouchableOpacity>)}
        </View>
        {shown.length===0?<View style={s.empty}><Text style={s.emptyT}>No bills this month.{'\n'}Tap + to add one.</Text></View>:shown.map(b=><BillCard key={b.id} bill={b} members={members} onPress={()=>onBill(b.id)} myMemberId={tab==='mine'?me?.id:undefined}/>)}
      </ScrollView>
    </View>
  );
}

function BillsScreen({group,members,bills,onBill}:{group:Group;members:Member[];bills:Bill[];onBill:(id:string)=>void}) {
  const ins=useSafeAreaInsets();
  return (
    <View style={{flex:1,backgroundColor:BG}}>
      <View style={[s.hdr,{paddingTop:ins.top+12}]}><Text style={s.hdrSub}>{group.name}</Text><Text style={s.hdrTitle}>Bills</Text></View>
      <ScrollView contentContainerStyle={{paddingBottom:20}} showsVerticalScrollIndicator={false}>
        {bills.length===0?<View style={s.empty}><Text style={s.emptyT}>No bills yet.{'\n'}Tap + to add one.</Text></View>:bills.map(b=><BillCard key={b.id} bill={b} members={members} onPress={()=>onBill(b.id)}/>)}
      </ScrollView>
    </View>
  );
}

function MembersScreen({group,members,bills,onAdd}:{group:Group;members:Member[];bills:Bill[];onAdd:(name:string)=>void}) {
  const ins=useSafeAreaInsets();
  const[showMo,setShowMo]=useState(false);const[newName,setNewName]=useState('');
  return (
    <View style={{flex:1,backgroundColor:BG}}>
      <View style={[s.hdr,{paddingTop:ins.top+12}]}><Text style={s.hdrSub}>{group.name}</Text><Text style={s.hdrTitle}>Members</Text></View>
      <ScrollView contentContainerStyle={{paddingBottom:20}} showsVerticalScrollIndicator={false}>
        <View style={{flexDirection:'row',gap:10,padding:16,paddingBottom:8}}>
          <TouchableOpacity style={[s.btnP,{flex:1,margin:0,paddingVertical:12}]} onPress={async()=>{try{await Share.share({message:`Join my Finly household: ${group.name}`});}catch{}}}><Text style={{color:'white',fontSize:13,fontWeight:'700'}}>Share Invite</Text></TouchableOpacity>
          <TouchableOpacity style={[s.btnO,{flex:1,paddingVertical:12}]} onPress={()=>{setNewName('');setShowMo(true);}}><Text style={{color:ACCENT,fontSize:13,fontWeight:'700'}}>+ Add Member</Text></TouchableOpacity>
        </View>
        {members.map(m=>{
          const mb=bills.filter(b=>b.assignedTo.some(a=>a.memberId===m.id));
          const over=mb.some(b=>billStatus(b)==='overdue'),soon=mb.some(b=>billStatus(b)==='due-soon');
          return (
            <View key={m.id} style={s.mr}>
              <Avatar name={m.name}/>
              <View style={{flex:1}}>
                <Text style={s.mrName}>{m.name}{m.isCurrentUser?<Text style={{fontSize:11,color:MUT,fontWeight:'400'}}> (you)</Text>:null}</Text>
                <Text style={s.mrSub}>{mb.length} bill{mb.length!==1?'s':''} this month</Text>
              </View>
              <Badge status={over?'overdue':soon?'due-soon':'clear'}/>
            </View>
          );
        })}
      </ScrollView>
      <Modal visible={showMo} transparent animationType="slide" onRequestClose={()=>setShowMo(false)}>
        <View style={s.sheetOverlay}><View style={s.sheet}><View style={s.shHandle}/><Text style={[s.shTitle,{padding:20,paddingBottom:4}]}>Add Member</Text><TextInput style={[s.fi,{margin:16,marginTop:12}]} placeholder="Name" placeholderTextColor={MUT} value={newName} onChangeText={setNewName} autoFocus returnKeyType="done"/><View style={[s.moBtns,{margin:16,marginTop:4}]}><TouchableOpacity style={s.btnCan} onPress={()=>setShowMo(false)}><Text style={{color:TXT2,fontWeight:'500'}}>Cancel</Text></TouchableOpacity><TouchableOpacity style={s.btnOk} onPress={()=>{if(!newName.trim())return;onAdd(newName.trim());setShowMo(false);}}><Text style={{color:'white',fontWeight:'700'}}>Add</Text></TouchableOpacity></View></View></View>
      </Modal>
    </View>
  );
}

function ActivityScreen({group,activity}:{group:Group;activity:Activity[]}) {
  const ins=useSafeAreaInsets();
  const grouped:{key:string;items:Activity[]}[]=[];let lastKey='';
  for(const a of activity){const k=dayKey(a.timestamp);if(k!==lastKey){grouped.push({key:k,items:[]});lastKey=k;}grouped[grouped.length-1].items.push(a);}
  return (
    <View style={{flex:1,backgroundColor:BG}}>
      <View style={[s.hdr,{paddingTop:ins.top+12}]}><Text style={s.hdrSub}>{group.name}</Text><Text style={s.hdrTitle}>Activity</Text></View>
      <ScrollView contentContainerStyle={{paddingBottom:20}} showsVerticalScrollIndicator={false}>
        {activity.length===0?<View style={s.empty}><Text style={s.emptyT}>No activity yet.</Text></View>:grouped.map(g=>(
          <View key={g.key}><Text style={s.actDt}>{g.key}</Text>{g.items.map(a=>(
            <View key={a.id} style={s.ai}><View style={[s.aiDot,{backgroundColor:a.type==='paid'?SUCCESS:ACCENT}]}/><View style={{flex:1}}><Text style={s.aiTxt}>{a.text}</Text><Text style={s.aiTime}>{fmtTs(a.timestamp)}</Text></View></View>
          ))}</View>
        ))}
      </ScrollView>
    </View>
  );
}

// ─── Dev Panel ────────────────────────────────────────────────────────────────
function DevPanel({visible,screen,onClose,onReset,onSkip,onDemo}:{visible:boolean;screen:string;onClose:()=>void;onReset:()=>void;onSkip:()=>void;onDemo:()=>void}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={{flex:1,backgroundColor:'rgba(0,0,0,0.6)'}} activeOpacity={1} onPress={onClose}/>
      <View style={{backgroundColor:SURFACE,borderTopLeftRadius:20,borderTopRightRadius:20,padding:24,paddingBottom:Platform.OS==='ios'?44:28,borderTopWidth:1,borderTopColor:BORDER}}>
        <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:6}}><Text style={{fontSize:16,fontWeight:'700',color:TXT}}>🛠 Developer</Text><TouchableOpacity onPress={onClose}><Text style={{color:MUT,fontSize:24,lineHeight:28}}>×</Text></TouchableOpacity></View>
        <Text style={{fontSize:12,color:MUT,fontFamily:'monospace',marginBottom:20}}>screen: {screen}</Text>
        {([['🗑  Reset all data','#3A0A0A',DANGER,onReset],['⚡  Skip to Dashboard','#0A1040',ACCENT2,onSkip],['🔄  Reload demo data','#0A280A',SUCCESS,onDemo]] as [string,string,string,()=>void][]).map(([l,bg,c,fn])=>(
          <TouchableOpacity key={l} style={{backgroundColor:bg,borderRadius:10,padding:14,marginBottom:10}} onPress={fn}><Text style={{color:c,fontWeight:'600',fontSize:14}}>{l}</Text></TouchableOpacity>
        ))}
      </View>
    </Modal>
  );
}

// ─── Auth Screen ─────────────────────────────────────────────────────────────
function AuthScreen({onAuth}:{onAuth:(u:AuthUser,isNew:boolean)=>void}) {
  const ins=useSafeAreaInsets();
  const[mode,setMode]=useState<'signin'|'signup'>('signin');
  const[name,setName]=useState('');
  const[email,setEmail]=useState('');
  const[password,setPassword]=useState('');
  const[loading,setLoading]=useState(false);
  const[err,setErr]=useState('');

  const submit=async()=>{
    setErr('');setLoading(true);
    try{
      if(mode==='signup'){
        if(!name.trim()){setErr('Enter your name');setLoading(false);return;}
        if(password.length<6){setErr('Password must be at least 6 characters');setLoading(false);return;}
        const{data,error}=await supabase.auth.signUp({email:email.trim(),password,options:{data:{name:name.trim()}}});
        if(error)throw error;
        if(data.user) onAuth({id:data.user.id,email:data.user.email!,name:name.trim()},true);
      }else{
        const{data,error}=await supabase.auth.signInWithPassword({email:email.trim(),password});
        if(error)throw error;
        if(data.user){const n=data.user.user_metadata?.name??data.user.email!.split('@')[0];onAuth({id:data.user.id,email:data.user.email!,name:n},false);}
      }
    }catch(e:any){setErr(e.message??'Something went wrong');}
    finally{setLoading(false);}
  };

  return (
    <View style={{flex:1,backgroundColor:BG,paddingTop:ins.top}}>
      <StatusBar style="light"/>
      <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==='ios'?'padding':'height'}>
        <ScrollView contentContainerStyle={{flexGrow:1,justifyContent:'center',padding:32}} keyboardShouldPersistTaps="handled">
          <View style={{alignItems:'center',marginBottom:36,gap:12}}>
            <FinlyMark size={64}/>
            <Text style={{color:TXT,fontSize:30,fontWeight:'700',letterSpacing:0.3}}>Finly</Text>
            <Text style={{color:TXT2,fontSize:14,textAlign:'center',lineHeight:20}}>Household bill tracking{'\n'}for Pakistani families</Text>
          </View>
          <View style={{flexDirection:'row',backgroundColor:SURF2,borderRadius:12,padding:4,marginBottom:24}}>
            {(['signin','signup'] as const).map(m=>(
              <TouchableOpacity key={m} style={{flex:1,paddingVertical:10,borderRadius:10,alignItems:'center',backgroundColor:mode===m?SURFACE:'transparent'}} onPress={()=>{setMode(m);setErr('');}}>
                <Text style={{fontWeight:'700',fontSize:13,color:mode===m?TXT:MUT}}>{m==='signin'?'Sign In':'Create Account'}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {mode==='signup'&&(
            <View style={{marginBottom:12}}>
              <Text style={[s.fl,{marginBottom:6}]}>Your Name</Text>
              <TextInput style={s.fi} placeholder="e.g. Zuhair" placeholderTextColor={MUT} value={name} onChangeText={setName} autoCapitalize="words"/>
            </View>
          )}
          <View style={{marginBottom:12}}>
            <Text style={[s.fl,{marginBottom:6}]}>Email</Text>
            <TextInput style={s.fi} placeholder="you@example.com" placeholderTextColor={MUT} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoCorrect={false}/>
          </View>
          <View style={{marginBottom:24}}>
            <Text style={[s.fl,{marginBottom:6}]}>Password</Text>
            <TextInput style={s.fi} placeholder={mode==='signup'?'Min 6 characters':'Your password'} placeholderTextColor={MUT} value={password} onChangeText={setPassword} secureTextEntry returnKeyType="done" onSubmitEditing={submit}/>
          </View>
          {err?<Text style={{color:DANGER,fontSize:13,marginBottom:16,textAlign:'center',lineHeight:18}}>{err}</Text>:null}
          <TouchableOpacity style={[s.btnP,{opacity:loading?0.7:1}]} onPress={submit} disabled={loading}>
            <Text style={{color:'white',fontWeight:'700',fontSize:15}}>{loading?'Please wait…':mode==='signin'?'Sign In':'Create Account'}</Text>
          </TouchableOpacity>
          {mode==='signup'&&<Text style={{color:MUT,fontSize:11,textAlign:'center',marginTop:16,lineHeight:16}}>By creating an account you agree to Finly's terms of service.</Text>}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

// ─── Onboarding ───────────────────────────────────────────────────────────────
function OnboardingScreen({onDone}:{onDone:(name:string)=>void}) {
  const ins=useSafeAreaInsets();
  const[slide,setSlide]=useState(0);const[name,setName]=useState('');
  const ref=useRef<ScrollView>(null);const{width:SW}=Dimensions.get('window');

  const slides=[
    {headline:'Never chase a bill again',sub:'One place for every household bill.\nAssign, track, done.'},
    {headline:'Create your household group',sub:'Invite family members. Each person sees what they owe this month.'},
    {headline:'Mark bills as paid',sub:'One tap to mark paid. Everyone in the group sees it instantly.'},
  ];

  const next=()=>{ if(slide<2){const n=slide+1;setSlide(n);ref.current?.scrollTo({x:n*SW,animated:true});}else{if(!name.trim())return;onDone(name.trim());} };

  // Slide illustrations using geometric shapes
  const Illus0=()=>(
    <View style={{width:120,height:120,alignItems:'center',justifyContent:'center'}}>
      {/* House outline in orange */}
      <View style={{width:70,height:50,backgroundColor:'transparent',borderWidth:3,borderColor:ACCENT,borderRadius:4,position:'absolute',bottom:10}}/>
      <View style={{width:0,height:0,borderLeftWidth:44,borderRightWidth:44,borderBottomWidth:36,borderLeftColor:'transparent',borderRightColor:'transparent',borderBottomColor:ACCENT,position:'absolute',top:18}}/>
      <View style={{width:16,height:22,backgroundColor:ACCENT,position:'absolute',bottom:10,borderRadius:2}}/>
    </View>
  );
  const Illus1=()=>(
    <View style={{width:120,height:90,alignItems:'center',justifyContent:'center'}}>
      <View style={{width:48,height:48,borderRadius:24,borderWidth:3,borderColor:ACCENT2,position:'absolute',left:10,top:10}}/>
      <View style={{width:48,height:48,borderRadius:24,borderWidth:3,borderColor:ACCENT,position:'absolute',left:36,top:10}}/>
      <View style={{width:48,height:48,borderRadius:24,borderWidth:3,borderColor:SUCCESS,position:'absolute',left:62,top:10}}/>
    </View>
  );
  const Illus2=()=>(
    <View style={{width:100,height:100,borderRadius:50,borderWidth:4,borderColor:SUCCESS,alignItems:'center',justifyContent:'center'}}>
      <Text style={{fontSize:42,color:SUCCESS,fontWeight:'900'}}>✓</Text>
    </View>
  );
  const illus=[<Illus0 key={0}/>,<Illus1 key={1}/>,<Illus2 key={2}/>];

  return (
    <View style={{flex:1,backgroundColor:BG}}>
      <ScrollView ref={ref} horizontal pagingEnabled scrollEnabled={false} showsHorizontalScrollIndicator={false} style={{flex:1}}>
        {slides.map((sl,i)=>(
          <View key={i} style={{width:SW,flex:1,alignItems:'center',justifyContent:'center',padding:36,gap:20}}>
            {i===0?(
              <View style={{alignItems:'center',gap:16}}>
                <FinlyMark size={80} bg={ACCENT}/>
                <Text style={{color:TXT,fontSize:38,fontWeight:'700',letterSpacing:0.5}}>Finly</Text>
              </View>
            ):illus[i]}
            <Text style={{fontSize:28,fontWeight:'700',color:TXT,textAlign:'center',lineHeight:36,letterSpacing:0.2}}>{sl.headline}</Text>
            <Text style={{fontSize:15,color:TXT2,textAlign:'center',lineHeight:24,maxWidth:280}}>{sl.sub}</Text>
            {i===2&&<TextInput style={s.obInp} placeholder="Your name" placeholderTextColor={MUT} value={name} onChangeText={setName} maxLength={24} returnKeyType="done" onSubmitEditing={next}/>}
          </View>
        ))}
      </ScrollView>
      <View style={{padding:24,paddingBottom:Math.max(ins.bottom,24)+8,backgroundColor:BG}}>
        <View style={{flexDirection:'row',justifyContent:'center',gap:6,marginBottom:20}}>
          {slides.map((_,i)=><View key={i} style={{height:6,borderRadius:3,backgroundColor:i===slide?ACCENT:MUT,width:i===slide?20:6}}/>)}
        </View>
        <TouchableOpacity style={s.btnP} onPress={next}><Text style={{color:'white',fontWeight:'700',fontSize:15}}>{slide===2?'Get Started':'Next'}</Text></TouchableOpacity>
      </View>
    </View>
  );
}

// ─── AppContent ───────────────────────────────────────────────────────────────
function AppContent() {
  const[loaded,   setLoaded]   = useState(false);
  const[screen,   setScreen]   = useState<Screen>('groups');
  const[showOb,   setShowOb]   = useState(false);
  const[prevScr,  setPrevScr]  = useState<Screen>('groups');
  const[gid,      setGid]      = useState<string|null>(null);
  const[bid,      setBid]      = useState<string|null>(null);
  const[tab,      setTab]      = useState<'all'|'mine'>('all');
  const[user,     setUser]     = useState<User|null>(null);
  const[groups,   setGroups]   = useState<Group[]>([]);
  const[members,  setMembers]  = useState<Member[]>([]);
  const[bills,    setBills]    = useState<Bill[]>([]);
  const[activity, setActivity] = useState<Activity[]>([]);
  const[templates,setTemplates]= useState<Template[]>([]);
  const[showAdd,  setShowAdd]  = useState(false);
  const[showDev,  setShowDev]  = useState(false);
  const[showProf, setShowProf] = useState(false);
  const[showJoin, setShowJoin] = useState(false);
  const[joinCode, setJoinCode] = useState('');
  const[authChecked,setAuthChecked]=useState(false);
  const[authUser,setAuthUser]=useState<AuthUser|null>(null);
  const[tapCount, setTapCount] = useState(0);
  const tapTimer  = useRef<ReturnType<typeof setTimeout>|null>(null);
  const toastAnim = useRef(new Animated.Value(0)).current;
  const[toastMsg, setToastMsg] = useState('');
  const screenRef   = useRef(screen); screenRef.current = screen;
  const showAddRef  = useRef(showAdd); showAddRef.current = showAdd;
  const ins = useSafeAreaInsets();

  const loadLocalData=async(userName?:string)=>{
    const tpls=await ensureTemplates();
    await seedIfEmpty();
    const[d,u,g,m,b,a]=await Promise.all([load<boolean>(K.done),load<User>(K.user),load<Group[]>(K.groups),load<Member[]>(K.members),load<Bill[]>(K.bills),load<Activity[]>(K.activity)]);
    setTemplates(tpls);
    const resolvedUser=u??{id:uid(),name:userName??'User'};
    setUser(resolvedUser);setGroups(g??[]);setMembers(m??[]);
    setBills(b?normalizeBills(b):[]);setActivity(a??[]);setLoaded(true);
    if(d){const first=(g??[])[0]?.id??null;setGid(first);setScreen('groups');}
  };

  const pullFromSupabase=async(userId:string)=>{
    try{
      const{data:gu}=await supabase.from('group_users').select('group_id').eq('user_id',userId);
      if(!gu?.length) return;
      const gIds=gu.map((r:any)=>r.group_id);
      const[gr,mr,br,ar,tr]=await Promise.all([
        supabase.from('groups').select('*').in('id',gIds),
        supabase.from('members').select('*').in('group_id',gIds),
        supabase.from('bills').select('*').in('group_id',gIds),
        supabase.from('activity').select('*').in('group_id',gIds).order('timestamp',{ascending:false}).limit(200),
        supabase.from('templates').select('*').eq('user_id',userId),
      ]);
      const mData=mr.data??[];
      if(gr.data?.length){
        const g:Group[]=gr.data.map((r:any)=>({id:r.id,name:r.name,emoji:r.emoji,createdAt:new Date(r.created_at).getTime(),memberIds:mData.filter((m:any)=>m.group_id===r.id).map((m:any)=>m.id)}));
        await save(K.groups,g);setGroups(g);
        const first=g[0]?.id??null;if(first){setGid(first);}
      }
      if(mData.length){
        const m:Member[]=mData.map((r:any)=>({id:r.id,name:r.name,groupId:r.group_id,isCurrentUser:r.is_current_user??false}));
        await save(K.members,m);setMembers(m);
      }
      if(br.data?.length){
        const b:Bill[]=br.data.map((r:any)=>({id:r.id,groupId:r.group_id,name:r.name,type:r.type,category:r.category,amount:r.amount,dueDate:r.due_date,month:r.month,status:r.status,paidAt:r.paid_at,paidBy:r.paid_by,createdAt:r.created_at,reminderDays:r.reminder_days,assignedTo:r.assigned_to??[],notifIds:r.notif_ids??[]}));
        await save(K.bills,b);setBills(normalizeBills(b));
      }
      if(ar.data?.length){
        const a:Activity[]=ar.data.map((r:any)=>({id:r.id,groupId:r.group_id,type:r.type,text:r.text,timestamp:r.timestamp}));
        await save(K.activity,a);setActivity(a);
      }
      if(tr.data?.length){
        const t:Template[]=tr.data.map((r:any)=>({id:r.id,name:r.name,category:r.category,dueDay:r.due_day,referenceNo:r.reference_no??''}));
        await save(K.templates,t);setTemplates(t);
      }
      await save(K.done,true);
    }catch{}
  };

  useEffect(()=>{
    (async()=>{
      if(Platform.OS==='android'){ try{ await NavigationBar.setPositionAsync('absolute'); await NavigationBar.setBackgroundColorAsync('rgba(0,0,0,0)'); await NavigationBar.setButtonStyleAsync('light'); }catch{} }
      await ensureNotifChannel();
      Notifications.requestPermissionsAsync().catch(()=>{});
      const{data:{session}}=await supabase.auth.getSession();
      if(session?.user){
        const n=session.user.user_metadata?.name??session.user.email!.split('@')[0];
        setAuthUser({id:session.user.id,email:session.user.email!,name:n});
        await loadLocalData(n);
        pullFromSupabase(session.user.id).catch(()=>{});
      }
      setAuthChecked(true);
    })();
  },[]);

  useEffect(()=>{
    const{data:{subscription}}=supabase.auth.onAuthStateChange((event)=>{
      if(event==='SIGNED_OUT'){setAuthUser(null);setLoaded(false);}
    });
    return()=>subscription.unsubscribe();
  },[]);

  useEffect(()=>{
    const sub=BackHandler.addEventListener('hardwareBackPress',()=>{
      if(showAddRef.current){setShowAdd(false);return true;}
      const s=screenRef.current;
      if(s==='groups') return false;
      if(s==='create-group'){setScreen('groups');return true;}
      if(s==='templates'){setScreen('groups');return true;}
      if(s==='dashboard'||s==='bills'||s==='members'||s==='activity'){setScreen('groups');return true;}
      if(s==='detail'){setScreen(prevScr);return true;}
      return false;
    });
    return ()=>sub.remove();
  },[prevScr]);

  function go(s:Screen){ setPrevScr(screen); setScreen(s); }

  function toast(msg:string){
    setToastMsg(msg);
    Animated.sequence([Animated.timing(toastAnim,{toValue:1,duration:200,useNativeDriver:true}),Animated.delay(2200),Animated.timing(toastAnim,{toValue:0,duration:300,useNativeDriver:true})]).start();
  }

  const saveB=async(b:Bill[])=>{ setBills(b);await save(K.bills,b);if(authUser)sbUpsertBills(b); };
  const saveM=async(m:Member[])=>{ setMembers(m);await save(K.members,m);if(authUser)sbUpsertMembers(m,authUser.id); };
  const saveG=async(g:Group[])=>{ setGroups(g);await save(K.groups,g);if(authUser)sbUpsertGroups(g,authUser.id); };
  const saveA=async(a:Activity[])=>{ setActivity(a);await save(K.activity,a);if(authUser)sbUpsertActivity(a); };
  const saveT=async(t:Template[])=>{ setTemplates(t);await save(K.templates,t);if(authUser)sbUpsertTemplates(t,authUser.id); };
  const logAct=async(type:Activity['type'],text:string)=>{ const a=[{id:uid(),groupId:gid!,type,text,timestamp:Date.now()},...activity].slice(0,200);await saveA(a); };

  function logoTap(){ const n=tapCount+1;setTapCount(n);if(tapTimer.current)clearTimeout(tapTimer.current);tapTimer.current=setTimeout(()=>setTapCount(0),1000);if(n>=5){setTapCount(0);setShowDev(true);} }

  const me          = members.find(m=>m.isCurrentUser&&m.groupId===gid);
  const curGroup    = groups.find(g=>g.id===gid)??{id:'',name:'',emoji:'🏠',createdAt:0,memberIds:[]};
  const curBills    = bills.filter(b=>b.groupId===gid&&b.month===monthStr());
  const curMembers  = members.filter(m=>m.groupId===gid);
  const curActivity = activity.filter(a=>a.groupId===gid);
  const insideGroup = screen!=='groups'&&screen!=='templates'&&screen!=='create-group';
  const detailBill  = bills.find(b=>b.id===bid);

  if(!authChecked) return <View style={{flex:1,backgroundColor:BG}}/>;
  if(!authUser) return (
    <AuthScreen onAuth={async(user,isNew)=>{
      setAuthUser(user);
      const u={id:uid(),name:user.name};
      await save(K.done,true);await save(K.user,u);setUser(u);
      await loadLocalData(user.name);
      pullFromSupabase(user.id).catch(()=>{});
      if(isNew){
        sbUpsertTemplates(await load<Template[]>(K.templates)??[],user.id);
      }
    }}/>
  );
  if(!loaded) return <View style={{flex:1,backgroundColor:BG}}/>;
  if(showOb) return <><StatusBar style="light"/><OnboardingScreen onDone={async name=>{ const u={id:uid(),name};await save(K.done,true);await save(K.user,u);setUser(u);const first=groups[0]?.id??null;setGid(first);setShowOb(false);setScreen('groups'); }}/></>;

  return (
    <View style={{flex:1,backgroundColor:BG}}>
      <StatusBar style="light"/>
      {screen==='groups'       && <GroupsScreen groups={groups} members={members} bills={bills} user={user} onGroup={id=>{setGid(id);setTab('all');go('dashboard');}} onCreateGroup={()=>go('create-group')} onJoinGroup={()=>setShowJoin(true)} onProfile={()=>setShowProf(true)} onSettings={()=>go('templates')} onLogoTap={logoTap}/>}
      {screen==='create-group' && <CreateGroupScreen user={user} onBack={()=>setScreen('groups')} onDone={async(g,mems)=>{ const ng=[...groups,g];const nm=[...members,...mems];await saveG(ng);await saveM(nm);setGid(g.id);await logAct('added',`${user?.name??'Someone'} created group "${g.name}"`);go('dashboard'); }}/>}
      {screen==='templates'    && <TemplatesScreen templates={templates} onBack={()=>setScreen('groups')} onSave={async t=>{ const exists=templates.some(x=>x.id===t.id);const nt=exists?templates.map(x=>x.id===t.id?t:x):[...templates,t];await saveT(nt);toast(exists?'Template updated!':'Template added!'); }} onDelete={async id=>{ await saveT(templates.filter(t=>t.id!==id));sbDeleteTemplate(id);toast('Template deleted'); }}/>}
      {screen==='dashboard'    && <DashboardScreen group={curGroup} members={curMembers} bills={curBills} tab={tab} onTabChange={setTab} onBill={id=>{setBid(id);go('detail');}} onProfile={()=>setShowProf(true)} onLogoTap={logoTap}/>}
      {screen==='bills'        && <BillsScreen group={curGroup} members={curMembers} bills={curBills} onBill={id=>{setBid(id);go('detail');}}/>}
      {screen==='detail'&&detailBill&&(
        <DetailScreen bill={detailBill} members={curMembers} me={me}
          onBack={()=>go(prevScr)}
          onMarkSharePaid={async memberId=>{
            let next:Bill[];
            if(!memberId){
              next=bills.map(b=>b.id===bid?{...b,status:'paid' as const,paidAt:todayStr(),paidBy:me?.id??null}:b);
            } else {
              next=bills.map(b=>{
                if(b.id!==bid) return b;
                const newAss=b.assignedTo.map(a=>a.memberId===memberId?{...a,paidAt:todayStr()}:a);
                const allPaid=newAss.every(a=>a.paidAt);
                return{...b,assignedTo:newAss,status:allPaid?'paid' as const:'partial' as const,paidAt:allPaid?todayStr():null,paidBy:allPaid?me?.id??null:null};
              });
            }
            await saveB(next);
            const m=curMembers.find(x=>x.id===memberId)||me;
            await logAct('paid',`${m?.name??'Someone'} marked their share of ${detailBill.name} as paid — Rs ${Number(memberId?detailBill.assignedTo.find(a=>a.memberId===memberId)?.amount:detailBill.amount).toLocaleString()}`);
            toast('Share marked as paid ✓');
          }}
          onDelete={async()=>{
            if(detailBill.notifIds?.length) await cancelBillNotifs(detailBill.notifIds);
            await saveB(bills.filter(b=>b.id!==bid));if(bid)sbDeleteBill(bid);await logAct('added',`Bill "${detailBill.name}" was deleted`);toast('Bill deleted');go(prevScr);
          }}/>
      )}
      {screen==='members'  && <MembersScreen group={curGroup} members={curMembers} bills={curBills} onAdd={async name=>{ const mid=uid();const nm=[...members,{id:mid,name,groupId:gid!,isCurrentUser:false}];await saveM(nm);const gi=groups.findIndex(x=>x.id===gid);if(gi!==-1){const ng=[...groups];ng[gi]={...ng[gi],memberIds:[...(ng[gi].memberIds??[]),mid]};await saveG(ng);}await logAct('added',`${name} was added to the group`);toast(`${name} added!`); }}/>}
      {screen==='activity' && <ActivityScreen group={curGroup} activity={curActivity}/>}

      {insideGroup&&screen!=='detail'&&(
        <BottomNav active={screen} onPress={s=>{ if((s as string)==='add'){setShowAdd(true);return;} go(s); }}/>
      )}

      <AddSheet visible={showAdd} members={curMembers} templates={templates} onClose={()=>setShowAdd(false)} onEditTemplates={()=>go('templates')}
        onSave={async nb=>{ nb.groupId=gid!; const ids=await scheduleBillNotif(nb,nb.reminderDays??null); if(ids.length)nb.notifIds=ids; await saveB([...bills,nb]); await logAct('added',`${me?.name??'Someone'} added ${nb.name} — Rs ${Number(nb.amount).toLocaleString()}`); setShowAdd(false); toast('Bill added!'); }}
      />

      <ProfileModal visible={showProf} user={user} email={authUser?.email} onClose={()=>setShowProf(false)}
        onRename={async n=>{ const u={...user!,name:n};await save(K.user,u);setUser(u);const nm=members.map(m=>m.isCurrentUser&&m.groupId===gid?{...m,name:n}:m);await saveM(nm);toast('Name updated!'); }}
        onReset={async()=>{ await AsyncStorage.multiRemove(Object.values(K));await Notifications.cancelAllScheduledNotificationsAsync();setGroups([]);setBills([]);setMembers([]);setActivity([]);setUser(null);setGid(null);setShowOb(true); }}
        onSignOut={async()=>{ await supabase.auth.signOut();await AsyncStorage.multiRemove(Object.values(K));await Notifications.cancelAllScheduledNotificationsAsync();setGroups([]);setBills([]);setMembers([]);setActivity([]);setUser(null);setGid(null); }}
      />

      <DevPanel visible={showDev} screen={screen} onClose={()=>setShowDev(false)}
        onReset={async()=>{ setShowDev(false);await AsyncStorage.multiRemove(Object.values(K));await Notifications.cancelAllScheduledNotificationsAsync();setGroups([]);setBills([]);setMembers([]);setActivity([]);setUser(null);setGid(null);setShowOb(true); }}
        onSkip={()=>{ setShowDev(false);if(gid)go('dashboard');else{const first=groups[0]?.id??null;setGid(first);setScreen('dashboard');} }}
        onDemo={async()=>{ setShowDev(false);await AsyncStorage.multiRemove([K.groups,K.members,K.bills,K.activity]);await seedIfEmpty();const[g,m,b,a]=await Promise.all([load<Group[]>(K.groups),load<Member[]>(K.members),load<Bill[]>(K.bills),load<Activity[]>(K.activity)]);setGroups(g??[]);setMembers(m??[]);setBills(b?normalizeBills(b):[]);setActivity(a??[]);const first=(g??[])[0]?.id??null;setGid(first);toast('Demo data reloaded'); }}
      />

      <Modal visible={showJoin} transparent animationType="slide" onRequestClose={()=>setShowJoin(false)}>
        <TouchableOpacity style={{flex:1,backgroundColor:'rgba(0,0,0,0.6)'}} activeOpacity={1} onPress={()=>setShowJoin(false)}/>
        <View style={[s.sheet,{paddingBottom:32}]}><View style={s.shHandle}/>
          <Text style={[s.shTitle,{padding:20,paddingBottom:4}]}>Join a Group</Text>
          <Text style={{fontSize:13,color:TXT2,paddingHorizontal:20,marginBottom:12}}>Ask the group admin to share an invite link from Members → Share Invite.</Text>
          <TextInput style={[s.fi,{margin:16,marginTop:4}]} placeholder="Enter group code" placeholderTextColor={MUT} value={joinCode} onChangeText={setJoinCode} autoFocus/>
          <View style={[s.moBtns,{margin:16,marginTop:4}]}>
            <TouchableOpacity style={s.btnCan} onPress={()=>setShowJoin(false)}><Text style={{color:TXT2,fontWeight:'500'}}>Cancel</Text></TouchableOpacity>
            <TouchableOpacity style={s.btnOk} onPress={()=>{setShowJoin(false);toast('Invite codes coming soon!');}}><Text style={{color:'white',fontWeight:'700'}}>Join</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Animated.View style={[s.toast,{opacity:toastAnim,bottom:72+ins.bottom,left:'50%',transform:[{translateX:-120}]}]} pointerEvents="none">
        <Text style={s.toastT}>{toastMsg}</Text>
      </Animated.View>
    </View>
  );
}

export default function App() {
  return <SafeAreaProvider><AppContent/></SafeAreaProvider>;
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  hdr:      {backgroundColor:BG,paddingHorizontal:20,paddingBottom:16,borderBottomWidth:1,borderBottomColor:BORDER},
  hdrTitle: {fontSize:20,fontWeight:'700',color:TXT,letterSpacing:0.2},
  hdrSub:   {fontSize:12,color:ACCENT2,marginBottom:2,fontWeight:'600',letterSpacing:0.5},
  backBtn:  {marginBottom:8},
  secTitle: {fontSize:11,fontWeight:'700',color:MUT,letterSpacing:0.8,padding:12,paddingBottom:4,textTransform:'uppercase'},
  nav:      {backgroundColor:SURFACE,flexDirection:'row',alignItems:'center',justifyContent:'space-around',paddingTop:10,borderTopWidth:1,borderTopColor:BORDER},
  navI:     {alignItems:'center',gap:4,paddingHorizontal:12},
  navL:     {fontSize:10,fontWeight:'600',letterSpacing:0.3},
  fab:      {width:54,height:54,backgroundColor:ACCENT,borderRadius:27,alignItems:'center',justifyContent:'center',marginTop:-20,
             shadowColor:ACCENT,shadowOffset:{width:0,height:0},shadowOpacity:0.6,shadowRadius:12,elevation:12},
  card:     {backgroundColor:SURFACE,borderRadius:16,borderWidth:1,borderColor:BORDER,marginHorizontal:16,marginVertical:5,padding:14,flexDirection:'row',alignItems:'center',gap:12},
  cardName: {fontSize:15,fontWeight:'700',color:TXT},
  cardMeta: {fontSize:12,color:TXT2},
  cardAmt:  {fontSize:15,fontWeight:'700',color:TXT},
  apill:    {backgroundColor:`${ACCENT2}22`,paddingHorizontal:7,paddingVertical:2,borderRadius:10},
  apillTxt: {fontSize:11,fontWeight:'600',color:ACCENT2},
  gc:       {backgroundColor:SURFACE,borderRadius:16,borderWidth:1,borderColor:BORDER,padding:16,marginHorizontal:16,marginVertical:5},
  gcName:   {fontSize:18,fontWeight:'700',color:TXT},
  gcSub:    {fontSize:12,color:TXT2,marginTop:3},
  statCard: {borderRadius:14,padding:14,borderWidth:1,borderColor:BORDER},
  statL:    {fontSize:11,fontWeight:'700',color:TXT2,marginBottom:6,textTransform:'uppercase'},
  statV:    {fontSize:36,fontWeight:'700',color:TXT},
  progBg:   {backgroundColor:SURF2,borderRadius:5,height:10,overflow:'hidden'},
  progFill: {backgroundColor:ACCENT,height:10,borderRadius:5},
  tab:      {paddingVertical:7,paddingHorizontal:18,borderRadius:20},
  tabOn:    {borderBottomWidth:2,borderBottomColor:ACCENT,borderRadius:0},
  tabT:     {fontSize:13,fontWeight:'600',color:MUT},
  tabTOn:   {color:ACCENT,fontWeight:'700'},
  empty:    {alignItems:'center',paddingVertical:52},
  emptyT:   {color:MUT,fontSize:14,textAlign:'center',lineHeight:22},
  detRows:  {backgroundColor:SURFACE,borderRadius:14,borderWidth:1,borderColor:BORDER,marginHorizontal:16,marginBottom:16,overflow:'hidden'},
  detRow:   {flexDirection:'row',justifyContent:'space-between',alignItems:'center',padding:14,borderBottomWidth:1,borderBottomColor:BORDER},
  drL:      {fontSize:13,color:TXT2},
  drV:      {fontSize:14,fontWeight:'600',color:TXT,textAlign:'right'},
  paidBox:  {backgroundColor:`${SUCCESS}18`,borderWidth:1,borderColor:`${SUCCESS}44`,borderRadius:12,marginHorizontal:16,marginBottom:16,padding:14},
  btnP:     {backgroundColor:ACCENT,borderRadius:14,paddingVertical:15,alignItems:'center'},
  btnGrn:   {backgroundColor:SUCCESS,borderRadius:12,paddingVertical:15,alignItems:'center'},
  btnO:     {borderWidth:1,borderColor:BORDER,borderRadius:14,paddingVertical:15,alignItems:'center',backgroundColor:SURFACE},
  btnW:     {backgroundColor:'white',borderRadius:12,paddingVertical:15,alignItems:'center'},
  mr:       {backgroundColor:SURFACE,borderRadius:14,borderWidth:1,borderColor:BORDER,marginHorizontal:16,marginVertical:5,padding:14,flexDirection:'row',alignItems:'center',gap:14},
  mrName:   {fontSize:15,fontWeight:'600',color:TXT},
  mrSub:    {fontSize:12,color:TXT2,marginTop:2},
  actDt:    {padding:10,paddingHorizontal:16,fontSize:11,fontWeight:'700',color:MUT,textTransform:'uppercase',letterSpacing:0.8},
  ai:       {backgroundColor:SURFACE,borderRadius:14,borderWidth:1,borderColor:BORDER,marginHorizontal:16,marginVertical:4,padding:13,flexDirection:'row',alignItems:'flex-start',gap:12},
  aiDot:    {width:10,height:10,borderRadius:5,marginTop:4,flexShrink:0},
  aiTxt:    {fontSize:14,color:TXT,lineHeight:20},
  aiTime:   {fontSize:11,color:MUT,marginTop:3},
  sheetOverlay:{flex:1,backgroundColor:'rgba(0,0,0,0.6)',justifyContent:'flex-end'},
  sheet:    {backgroundColor:SURFACE,borderTopLeftRadius:24,borderTopRightRadius:24,paddingBottom:Platform.OS==='ios'?36:24,borderTopWidth:1,borderTopColor:BORDER},
  shHandle: {width:36,height:4,backgroundColor:MUT,borderRadius:2,margin:12,alignSelf:'center'},
  shHdr:    {flexDirection:'row',alignItems:'center',justifyContent:'space-between',padding:16,paddingTop:4},
  shTitle:  {fontSize:17,fontWeight:'700',color:TXT},
  ff:       {marginHorizontal:16,marginBottom:16},
  fl:       {fontSize:12,fontWeight:'700',color:TXT2,marginBottom:7,textTransform:'uppercase',letterSpacing:0.5},
  fi:       {backgroundColor:SURF2,borderRadius:10,borderWidth:1,borderColor:BORDER,paddingHorizontal:14,paddingVertical:13,fontSize:15,color:TXT},
  typeOpt:  {flex:1,paddingVertical:10,borderRadius:10,borderWidth:1,borderColor:BORDER,backgroundColor:SURF2,alignItems:'center'},
  typeOptOn:{backgroundColor:`${ACCENT}22`,borderColor:ACCENT},
  typeOptT: {fontSize:12,color:MUT,textAlign:'center',lineHeight:16},
  typeOptTOn:{color:ACCENT,fontWeight:'700'},
  chip:     {paddingVertical:8,paddingHorizontal:14,borderRadius:20,borderWidth:1,borderColor:BORDER,backgroundColor:SURF2},
  chipOn:   {backgroundColor:ACCENT,borderColor:ACCENT},
  chipT:    {fontSize:13,color:TXT2},
  chipTOn:  {color:'white',fontWeight:'700'},
  moBtns:   {flexDirection:'row',gap:10},
  btnCan:   {flex:1,paddingVertical:13,backgroundColor:SURF2,borderRadius:10,alignItems:'center'},
  btnOk:    {flex:1,paddingVertical:13,backgroundColor:ACCENT,borderRadius:10,alignItems:'center'},
  obInp:    {backgroundColor:SURF2,borderWidth:1,borderColor:BORDER,borderRadius:12,paddingHorizontal:16,paddingVertical:14,color:TXT,fontSize:15,width:'100%'},
  toast:    {position:'absolute',backgroundColor:SURFACE,borderWidth:1,borderColor:BORDER,paddingHorizontal:20,paddingVertical:10,borderRadius:20,minWidth:240,alignItems:'center'},
  toastT:   {color:TXT,fontSize:13,fontWeight:'500'},
});
