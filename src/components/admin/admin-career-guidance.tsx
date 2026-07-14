"use client";

import { BriefcaseBusiness, ExternalLink, Plus, RefreshCw, Send, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import styles from "@/components/milestones/milestones.module.css";

type Course = { id: string; slug: string; title: string; currentVersion: string | null; currentStage: string | null; eligibleForPublishedPrerequisite: boolean };
type Card = {
  id: string; slug: string; path: string; technology: string; title: string; summary: string; futureScope: string;
  status: string; rowVersion: number; market: { claim: string; sourceUrl: string; region: string; observedAt: string; reviewedAt: string; expiresAt: string } | null;
  prerequisites: Array<{ courseId: string; rationale: string }>;
};
type Payload = { cards: Card[]; courses: Course[] };
type FormState = {
  cardId: string | null; expectedVersion: number; slug: string; path: string; technology: string;
  title: string; summary: string; futureScope: string; reason: string; prerequisiteRationales: Record<string,string>;
  marketEnabled: boolean; marketClaim: string; marketSourceUrl: string; marketRegion: string;
  marketObservedAt: string; marketReviewedAt: string; marketExpiresAt: string;
};

const blank = (): FormState => ({ cardId: null, expectedVersion: 0, slug: "", path: "", technology: "", title: "", summary: "", futureScope: "", reason: "Administrator authored and reviewed this career guidance.", prerequisiteRationales: {}, marketEnabled: false, marketClaim: "", marketSourceUrl: "", marketRegion: "", marketObservedAt: "", marketReviewedAt: "", marketExpiresAt: "" });
function localDateTime(iso: string) { const date = new Date(iso); const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000); return local.toISOString().slice(0,16); }
function isoDateTime(value: string) { const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new Error("Enter valid market dates."); return date.toISOString(); }

export function AdminCareerGuidance() {
  const [data, setData] = useState<Payload | null>(null);
  const [form, setForm] = useState<FormState>(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/career", { cache: "no-store" });
    const body = await response.json() as Payload & { error?: string };
    if (!response.ok) throw new Error(body.error ?? "CAREER_LOAD_FAILED");
    setData(body);
  }, []);
  useEffect(() => { let active = true; void fetch("/api/admin/career",{cache:"no-store"}).then(async response => { const body=await response.json() as Payload & {error?:string}; if(!response.ok) throw new Error(body.error??"CAREER_LOAD_FAILED"); if(active)setData(body); }).catch((cause:unknown)=>{if(active)setError(cause instanceof Error?cause.message:"CAREER_LOAD_FAILED");}); return()=>{active=false;}; },[]);

  function choose(card: Card) {
    setError(null); setMessage(null);
    setForm({ cardId: card.id, expectedVersion: card.rowVersion, slug: card.slug, path: card.path, technology: card.technology, title: card.title, summary: card.summary, futureScope: card.futureScope, reason: "Administrator reviewed this career guidance and its prerequisites.", prerequisiteRationales: Object.fromEntries(card.prerequisites.map((item) => [item.courseId,item.rationale])), marketEnabled: Boolean(card.market), marketClaim: card.market?.claim ?? "", marketSourceUrl: card.market?.sourceUrl ?? "", marketRegion: card.market?.region ?? "", marketObservedAt: card.market ? localDateTime(card.market.observedAt) : "", marketReviewedAt: card.market ? localDateTime(card.market.reviewedAt) : "", marketExpiresAt: card.market ? localDateTime(card.market.expiresAt) : "" });
  }
  function field<K extends keyof FormState>(key: K, value: FormState[K]) { setForm((current) => ({ ...current, [key]: value })); }
  function toggleCourse(courseId: string) { setForm((current) => { const next={...current.prerequisiteRationales}; if(courseId in next) delete next[courseId]; else next[courseId]="Complete this verified foundation before starting the path."; return {...current,prerequisiteRationales:next}; }); }

  async function submit(action: "save"|"publish"|"retire") {
    setBusy(true); setError(null); setMessage(null);
    try {
      const market = form.marketEnabled ? { claim: form.marketClaim, sourceUrl: form.marketSourceUrl, region: form.marketRegion, observedAt: isoDateTime(form.marketObservedAt), reviewedAt: isoDateTime(form.marketReviewedAt), expiresAt: isoDateTime(form.marketExpiresAt) } : null;
      const response = await fetch("/api/admin/career", { method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ requestId:crypto.randomUUID(),cardId:form.cardId,expectedVersion:form.expectedVersion,action,slug:form.slug,path:form.path,technology:form.technology,title:form.title,summary:form.summary,futureScope:form.futureScope,reason:form.reason,market,prerequisites:Object.entries(form.prerequisiteRationales).map(([courseId,rationale])=>({courseId,rationale})) }) });
      const body = await response.json() as { cards?: Card[]; result?: { cardId:string }; error?: string };
      if(!response.ok) throw new Error(body.error??"CAREER_MUTATION_FAILED");
      await load();
      const updated=(body.cards??[]).find((card)=>card.id===body.result?.cardId);
      if(updated) choose(updated); else setForm(blank());
      setMessage(action==="publish"?"Career card published from administrator-reviewed content.":action==="retire"?"Career card retired.":"Draft saved. Publishing remains a separate action.");
    } catch(cause) { setError(cause instanceof Error?cause.message:"CAREER_MUTATION_FAILED"); }
    finally { setBusy(false); }
  }

  return <div className={styles.page}>
    <header className={styles.hero}><div><span className={styles.eyebrow}>Career editorial desk</span><h1>Publish paths, not predictions.</h1><p>Author prerequisites and future scope. Market-demand language is optional, sourced, regional, dated, expiring, and attributable to the administrator.</p></div><div className={styles.heroActions}><button className="button button-secondary" onClick={()=>setForm(blank())} type="button"><Plus size={15}/> New draft</button><button className="button button-secondary" onClick={()=>void load().catch((cause:unknown)=>setError(cause instanceof Error?cause.message:"CAREER_LOAD_FAILED"))} type="button"><RefreshCw size={15}/> Refresh</button></div></header>
    <aside className={styles.notice}><ShieldCheck size={19}/><span>A card cannot publish when any prerequisite lacks a current verified course version, or when a market claim lacks a source URL, region, observation/review/expiry dates, and administrator identity.</span></aside>
    <div aria-live="polite">{error?<p className={styles.error}>{error}</p>:null}{message?<p className={styles.success}>{message}</p>:null}</div>
    <div className={styles.adminLayout}>
      <section className={`${styles.panel} card ${styles.adminList}`}><div className={styles.panelHead}><div><h2>Editorial queue</h2><p>{data?.cards.length??0} cards</p></div></div><div className={styles.collection}>{data?.cards.map(card=><button aria-current={form.cardId===card.id} key={card.id} onClick={()=>choose(card)} type="button"><strong>{card.title}</strong><br/><small>{card.technology} · {card.status} · v{card.rowVersion}</small></button>)}</div></section>
      <section className={`${styles.panel} card`}><div className={styles.panelHead}><div><h2>{form.cardId?"Edit career card":"New career draft"}</h2><p>Saving a published card moves it back to draft until explicitly republished.</p></div></div>
        <div className={styles.form}>
          <div className={styles.fieldGrid}><label>Slug<input value={form.slug} onChange={event=>field("slug",event.target.value.toLowerCase())}/></label><label>Path<input value={form.path} onChange={event=>field("path",event.target.value)}/></label></div>
          <div className={styles.fieldGrid}><label>Technology<input value={form.technology} onChange={event=>field("technology",event.target.value)}/></label><label>Title<input value={form.title} onChange={event=>field("title",event.target.value)}/></label></div>
          <label>Summary<textarea value={form.summary} onChange={event=>field("summary",event.target.value)}/></label>
          <label>Future scope<textarea value={form.futureScope} onChange={event=>field("futureScope",event.target.value)}/></label>
          <fieldset className={styles.checkList}><legend>Verified course prerequisites</legend>{data?.courses.map(course=><label className={styles.checkRow} key={course.id}><input checked={course.id in form.prerequisiteRationales} onChange={()=>toggleCourse(course.id)} type="checkbox"/><span><strong>{course.title} · {course.currentVersion??"no current version"}</strong><small>{course.currentStage??"unpublished"}{course.eligibleForPublishedPrerequisite?" · publishable":" · blocks publication"}</small>{course.id in form.prerequisiteRationales?<input aria-label={`Rationale for ${course.title}`} value={form.prerequisiteRationales[course.id]} onChange={event=>field("prerequisiteRationales",{...form.prerequisiteRationales,[course.id]:event.target.value})}/>:null}</span></label>)}</fieldset>
          <label className={styles.disclosure}><input checked={form.marketEnabled} onChange={event=>field("marketEnabled",event.target.checked)} type="checkbox"/><span><strong>Include a time-sensitive market claim</strong><small>Optional. The claim disappears from learner guidance after expiry until reviewed again.</small></span></label>
          {form.marketEnabled?<><label>Claim<textarea value={form.marketClaim} onChange={event=>field("marketClaim",event.target.value)}/></label><div className={styles.fieldGrid}><label>HTTPS source URL<input type="url" value={form.marketSourceUrl} onChange={event=>field("marketSourceUrl",event.target.value)}/></label><label>Region<input value={form.marketRegion} onChange={event=>field("marketRegion",event.target.value)}/></label></div><div className={styles.fieldGrid}><label>Observed<input type="datetime-local" value={form.marketObservedAt} onChange={event=>field("marketObservedAt",event.target.value)}/></label><label>Reviewed<input type="datetime-local" value={form.marketReviewedAt} onChange={event=>field("marketReviewedAt",event.target.value)}/></label></div><label>Expires<input type="datetime-local" value={form.marketExpiresAt} onChange={event=>field("marketExpiresAt",event.target.value)}/></label>{form.marketSourceUrl?<a className={styles.marketSource} href={form.marketSourceUrl} rel="noreferrer" target="_blank">Open source <ExternalLink size={14}/></a>:null}</>:null}
          <label>Editorial reason<input value={form.reason} onChange={event=>field("reason",event.target.value)}/></label>
          <div className={styles.actions}><button className="button button-secondary" disabled={busy} onClick={()=>void submit("save")} type="button">Save draft</button><button className="button button-primary" disabled={busy||!form.cardId} onClick={()=>void submit("publish")} type="button"><Send size={15}/> Publish reviewed card</button>{form.cardId?<button className="button button-secondary" disabled={busy} onClick={()=>void submit("retire")} type="button"><BriefcaseBusiness size={15}/> Retire</button>:null}</div>
        </div>
      </section>
    </div>
  </div>;
}
