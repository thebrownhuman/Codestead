"use client";

import {
  AlertTriangle, CalendarClock, ChevronDown, Flag, Gamepad2, LockKeyhole,
  MessageCircle, Pencil, Plus, RefreshCw, Send, ShieldCheck, Trash2, Trophy, Users,
} from "lucide-react";
import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import styles from "./community-spaces.module.css";

type Person = { publicId: string; alias: string };
type Group = {
  id: string; name: string; description: string; visibility: string; status: string;
  membershipRole: string | null; memberCount: number;
};
type Reply = {
  id: string; body: string; rowVersion: number; createdAt: string; editedAt: string | null;
  authorAlias: string; own: boolean;
};
type Post = {
  id: string; groupId: string; kind: string; title: string; body: string; rowVersion: number;
  createdAt: string; editedAt: string | null; authorAlias: string; own: boolean; replies: Reply[];
};
type DiscussionPayload = { groups: Group[]; posts: Post[]; nextCursor: string | null; moderation: boolean; privacy: string };
type Battle = {
  id: string; scope: "invite" | "cohort" | "weekly" | "monthly"; competitionKey: string | null;
  title: string; language: string; skillKey: string; challengeKind: "authored_answer" | "verified_attempt";
  maxPoints: number; status: string; startsAt: string; endsAt: string; revealAt: string;
  participantCount: number; submissionCount: number; participant: boolean; submitted: boolean; canJoin: boolean;
  prompt: { instructions: string; specification: Record<string, unknown> } | null; limitations: string;
};
type BattlePayload = {
  battles: Battle[];
  sources: Array<{ activityId: string; skillKey: string; title: string; language: string; kind: string }>;
  scoring: { version: string; rule: string; reveal: string };
};
type BattleDetail = { battle: Battle; resultsRevealed: boolean; results: Array<{ rank: number; alias: string; score: number; passed: boolean }> };
type Report = { id: string; target: "post" | "reply"; targetId: string; reason: string; details: string | null; status: string; excerpt: string; createdAt: string };
type CommunityTab = "discuss" | "battle";

const communityTabs: readonly CommunityTab[] = ["discuss", "battle"];

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "The request failed safely. Try again.");
  return body;
}

function usePhoneLayout() {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return phone;
}

function assertCommunityPayloads(discussion: DiscussionPayload, battles: BattlePayload) {
  if (!Array.isArray(discussion.groups) || !Array.isArray(discussion.posts)
    || !Array.isArray(battles.battles) || !Array.isArray(battles.sources)) {
    throw new Error("Community spaces returned an invalid safe response.");
  }
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function ReportControl({ target, targetId, onDone }: { target: "post" | "reply"; targetId: string; onDone: (notice: string) => void }) {
  const [reason, setReason] = useState<"harassment" | "unsafe_code" | "spam" | "privacy" | "other">("other");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true); setError(null);
    try {
      await requestJson("/api/community/discussions", {
        method: "POST",
        body: JSON.stringify({ action: "report", target, targetId, reason, details: "Please review this cohort content." }),
      });
      onDone("Report sent privately to the administrator. The author was not notified by this action.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The report could not be sent safely.");
    } finally { setBusy(false); }
  }
  return <details className={styles.actionDetails}>
    <summary><Flag size={14} /> Report</summary>
    <div className={styles.inlineAction}>
      <label>Reason<select value={reason} onChange={(event) => setReason(event.target.value as typeof reason)}>
        <option value="other">Other concern</option><option value="harassment">Harassment</option>
        <option value="unsafe_code">Unsafe code</option><option value="spam">Spam</option><option value="privacy">Privacy</option>
      </select></label>
      <button type="button" className="button button-secondary" onClick={() => void submit()} disabled={busy}>Send report</button>
      {error && <small role="alert">{error}</small>}
    </div>
  </details>;
}

function BattleAnswerFields({ battle }: { battle: Battle }) {
  if (battle.challengeKind === "verified_attempt") {
    return <label>Independently graded attempt ID<input name="attemptId" pattern="[0-9a-fA-F-]{36}" required /></label>;
  }
  const prompt = battle.prompt;
  if (!prompt) return null;
  const options = Array.isArray(prompt.specification.options)
    ? prompt.specification.options as Array<{ id: string; text: string }>
    : [];
  if (options.length === 0) return <label>Your answer<input name="answerText" required /></label>;
  const multiple = prompt.specification.multiple === true;
  return <fieldset><legend>Your answer</legend>{options.map((option) => <label className={styles.choice} key={option.id}><input type={multiple ? "checkbox" : "radio"} name="answer" value={option.id} required={!multiple} /><span>{option.text}</span></label>)}</fieldset>;
}

export function CommunitySpaces({ people }: { people: Person[] }) {
  const phone = usePhoneLayout();
  const [tab, setTab] = useState<CommunityTab>("discuss");
  const [discussion, setDiscussion] = useState<DiscussionPayload | null>(null);
  const [battles, setBattles] = useState<BattlePayload | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<string>("");
  const [battleFilter, setBattleFilter] = useState<"all" | Battle["scope"]>("all");
  const [detail, setDetail] = useState<BattleDetail | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ target: "post" | "reply"; id: string; version: number; title: string; body: string } | null>(null);
  const [replying, setReplying] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const logicalRequestIds = useRef(new Map<string, { fingerprint: string; requestId: string }>());

  function requestIdFor(key: string, payload: Record<string, unknown>) {
    const fingerprint = JSON.stringify(payload);
    const prior = logicalRequestIds.current.get(key);
    if (prior?.fingerprint === fingerprint) return prior.requestId;
    const requestId = crypto.randomUUID();
    logicalRequestIds.current.set(key, { fingerprint, requestId });
    return requestId;
  }

  function completeRequest(key: string) {
    logicalRequestIds.current.delete(key);
  }

  function onTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, current: CommunityTab) {
    const currentIndex = communityTabs.indexOf(current);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % communityTabs.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + communityTabs.length) % communityTabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = communityTabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = communityTabs[nextIndex]!;
    setTab(next);
    document.getElementById(`community-tab-${next}`)?.focus();
  }

  const load = useCallback(async (groupId?: string, append = false, cursor?: string | null) => {
    setError(null);
    const query = new URLSearchParams();
    if (groupId) query.set("groupId", groupId);
    if (cursor) query.set("cursor", cursor);
    const [nextDiscussion, nextBattles] = await Promise.all([
      requestJson<DiscussionPayload>(`/api/community/discussions?${query}`),
      requestJson<BattlePayload>("/api/battles"),
    ]);
    assertCommunityPayloads(nextDiscussion, nextBattles);
    setDiscussion((current) => append && current
      ? { ...nextDiscussion, posts: [...current.posts, ...nextDiscussion.posts] }
      : nextDiscussion);
    setBattles(nextBattles);
    setSelectedGroup((current) => current || nextDiscussion.groups[0]?.id || "");
    if (nextDiscussion.moderation) {
      const moderation = await requestJson<{ reports: Report[] }>("/api/admin/community/moderation");
      setReports(moderation.reports);
    }
  }, []);

  const loadSafely = useCallback((groupId?: string, append = false, cursor?: string | null) => {
    void load(groupId, append, cursor).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Community spaces could not be refreshed.");
    });
  }, [load]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      requestJson<DiscussionPayload>("/api/community/discussions"),
      requestJson<BattlePayload>("/api/battles"),
    ]).then(([nextDiscussion, nextBattles]) => {
      if (!active) return;
      assertCommunityPayloads(nextDiscussion, nextBattles);
      setDiscussion(nextDiscussion);
      setBattles(nextBattles);
      setSelectedGroup(nextDiscussion.groups[0]?.id ?? "");
      if (nextDiscussion.moderation) {
        void requestJson<{ reports: Report[] }>("/api/admin/community/moderation")
          .then((value) => { if (active) setReports(value.reports); })
          .catch(() => { if (active) setError("The discussion loaded, but the moderation queue did not."); });
      }
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Community spaces are unavailable."); });
    return () => { active = false; };
  }, []);

  async function mutate(payload: Record<string, unknown>, success: string) {
    setBusy(true); setError(null); setNotice(null);
    try {
      await requestJson("/api/community/discussions", { method: "POST", body: JSON.stringify(payload) });
      setNotice(success);
      try {
        await load(selectedGroup || undefined);
      } catch {
        setError("Your change was saved, but the latest community view could not refresh. Use Refresh to reconcile it.");
      }
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The community change failed safely.");
      return false;
    }
    finally { setBusy(false); }
  }

  async function createGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const payload = { action: "create_group", name: form.get("name"), description: form.get("description"), visibility: form.get("visibility") };
    const requestKey = "create_group";
    if (await mutate({ ...payload, requestId: requestIdFor(requestKey, payload) }, "Group created. Add members before sharing in a private group.")) {
      completeRequest(requestKey);
      formElement.reset();
    }
  }

  async function createPost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const payload = { action: "create_post", groupId: selectedGroup, kind: form.get("kind"), title: form.get("title"), body: form.get("body") };
    const requestKey = `create_post:${selectedGroup}`;
    if (await mutate({ ...payload, requestId: requestIdFor(requestKey, payload) }, "Post added to the selected group.")) {
      completeRequest(requestKey);
      formElement.reset();
    }
  }

  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = { action: "add_member", groupId: selectedGroup, learnerPublicId: form.get("learnerPublicId") };
    const requestKey = `add_member:${selectedGroup}`;
    if (await mutate({ ...payload, requestId: requestIdFor(requestKey, payload) }, "Learner added to the private group.")) {
      completeRequest(requestKey);
    }
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    if (await mutate({ action: "edit", target: editing.target, targetId: editing.id, expectedVersion: editing.version, title: editing.target === "post" ? editing.title : undefined, body: editing.body }, "Your edit is live.")) {
      setEditing(null);
    }
  }

  async function reply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!replying) return;
    const payload = { action: "reply", postId: replying, body: replyBody };
    const requestKey = `reply:${replying}`;
    if (await mutate({ ...payload, requestId: requestIdFor(requestKey, payload) }, "Reply posted.")) {
      completeRequest(requestKey);
      setReplying(null); setReplyBody("");
    }
  }

  async function createBattle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phone) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const scope = String(form.get("scope"));
    const invite = String(form.get("invite") ?? "");
    const payload = {
      activityId: form.get("activityId"), scope,
      invitedPublicIds: scope === "invite" && invite ? [invite] : [],
      durationMinutes: scope === "invite" || scope === "cohort" ? Number(form.get("durationMinutes")) : undefined,
      competitionKey: scope === "weekly" || scope === "monthly" ? form.get("competitionKey") : undefined,
    };
    const requestKey = "create_battle";
    setBusy(true); setError(null); setNotice(null);
    try {
      await requestJson("/api/battles", {
        method: "POST",
        body: JSON.stringify({ ...payload, requestId: requestIdFor(requestKey, payload) }),
      });
      setNotice("Battle created from a frozen, human-reviewed activity.");
      completeRequest(requestKey);
      formElement.reset();
      try {
        await load(selectedGroup || undefined);
      } catch {
        setError("The battle was created, but the challenge board could not refresh. Use Refresh to reconcile it.");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Battle creation failed safely."); }
    finally { setBusy(false); }
  }

  async function battleAction(battleId: string, payload: Record<string, unknown>, success: string) {
    if (phone) return false;
    setBusy(true); setError(null); setNotice(null);
    try {
      await requestJson(`/api/battles/${battleId}`, { method: "POST", body: JSON.stringify(payload) });
      setNotice(success);
      try {
        await load(selectedGroup || undefined);
        setDetail(await requestJson<BattleDetail>(`/api/battles/${battleId}`));
      } catch {
        setError("Your battle action was saved, but the board could not refresh. Use Refresh to reconcile it.");
      }
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Battle action failed safely.");
      return false;
    }
    finally { setBusy(false); }
  }

  async function submitBattleAnswer(event: FormEvent<HTMLFormElement>, battle: Battle) {
    event.preventDefault();
    if (!battle.prompt) {
      setError("Challenge details are still sealed. Refresh when the battle opens.");
      return;
    }
    const form = new FormData(event.currentTarget);
    const requestKey = `battle_submit:${battle.id}`;
    if (battle.challengeKind === "verified_attempt") {
      const payload = { action: "submit", attemptId: form.get("attemptId") };
      if (await battleAction(battle.id, { ...payload, requestId: requestIdFor(requestKey, payload) }, "Verified attempt accepted. Score stays hidden until reveal.")) {
        completeRequest(requestKey);
      }
      return;
    }
    const multiple = battle.prompt.specification.multiple === true;
    const options = Array.isArray(battle.prompt.specification.options) ? battle.prompt.specification.options : [];
    const answer = options.length
      ? multiple
        ? { selectedOptionIds: form.getAll("answer") }
        : { value: form.get("answer") }
      : { value: form.get("answerText") };
    const payload = { action: "submit", answer };
    if (await battleAction(battle.id, { ...payload, requestId: requestIdFor(requestKey, payload) }, "Answer accepted. Score stays hidden until reveal.")) {
      completeRequest(requestKey);
    }
  }

  async function moderate(report: Report, action: "hide" | "restore") {
    setBusy(true); setError(null);
    try {
      const reason = action === "hide" ? "Content hidden after administrator review." : "Report dismissed after administrator review.";
      const payload = { reportId: report.id, target: report.target, targetId: report.targetId, action, reason };
      const requestKey = `moderation:${report.id}:${action}`;
      await requestJson("/api/admin/community/moderation", {
        method: "POST",
        body: JSON.stringify({ ...payload, requestId: requestIdFor(requestKey, payload) }),
      });
      completeRequest(requestKey);
      setNotice(action === "hide" ? "Content hidden and report resolved." : "Content restored and report dismissed.");
      try {
        await load(selectedGroup || undefined);
      } catch {
        setError("The moderation decision was saved, but the queue could not refresh. Use Refresh to reconcile it.");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Moderation failed safely."); }
    finally { setBusy(false); }
  }

  const visiblePosts = useMemo(() => selectedGroup ? discussion?.posts.filter((post) => post.groupId === selectedGroup) ?? [] : [], [discussion, selectedGroup]);
  const selected = discussion?.groups.find((group) => group.id === selectedGroup);
  const filteredBattles = battles?.battles.filter((battle) => battleFilter === "all" || battle.scope === battleFilter) ?? [];

  if (!discussion || !battles) return <section className={styles.shell} aria-busy={!error}>
    <div className={styles.state}><RefreshCw size={24} /><h2>{error ? "Community spaces are unavailable" : "Opening community spaces"}</h2><p>No private group or battle answer is exposed while this view loads.</p>{error && <><p role="alert">{error}</p><button type="button" className="button button-secondary" onClick={() => loadSafely()}>Retry</button></>}</div>
  </section>;

  return <section className={styles.shell} aria-labelledby="community-spaces-title">
    <header className={styles.header}>
      <div><span className={styles.eyebrow}>Learn together, privately</span><h2 id="community-spaces-title">Community spaces & coding battles</h2><p>Ask for help, share a project, or solve the same reviewed challenge asynchronously. This is not a public forum.</p></div>
      <button type="button" className="button button-secondary" onClick={() => loadSafely(selectedGroup || undefined)} disabled={busy}><RefreshCw size={15} /> Refresh</button>
    </header>
    <div className={styles.tabs} role="tablist" aria-label="Community section">
      <button type="button" role="tab" id="community-tab-discuss" aria-controls="community-panel-discuss" aria-selected={tab === "discuss"} tabIndex={tab === "discuss" ? 0 : -1} onKeyDown={(event) => onTabKeyDown(event, "discuss")} onClick={() => setTab("discuss")}><MessageCircle size={17} /> Discuss & help</button>
      <button type="button" role="tab" id="community-tab-battle" aria-controls="community-panel-battle" aria-selected={tab === "battle"} tabIndex={tab === "battle" ? 0 : -1} onKeyDown={(event) => onTabKeyDown(event, "battle")} onClick={() => setTab("battle")}><Gamepad2 size={17} /> Battles</button>
    </div>
    {error && <p className={styles.error} role="alert"><AlertTriangle size={16} /> {error}</p>}
    {notice && <p className={styles.notice} role="status"><ShieldCheck size={16} /> {notice}</p>}

    {tab === "discuss" && <div className={styles.discussionGrid} id="community-panel-discuss" role="tabpanel" aria-labelledby="community-tab-discuss">
      <aside className={styles.rail}>
        <div className={styles.railTitle}><Users size={17} /><strong>Groups</strong></div>
        {discussion.groups.length ? discussion.groups.map((group) => <button type="button" key={group.id} className={selectedGroup === group.id ? styles.groupActive : styles.group} onClick={() => { setSelectedGroup(group.id); loadSafely(group.id); }}>
          <span><strong>{group.name}</strong><small>{group.memberCount} members · {group.visibility === "members" ? "private" : "cohort"}</small></span><ChevronDown size={14} />
        </button>) : <div className={styles.miniEmpty}><p>No groups yet.</p><small>Create the first focused study space.</small></div>}
        <details className={styles.createPanel}><summary><Plus size={15} /> New group</summary><form onSubmit={(event) => void createGroup(event)}>
          <label>Name<input name="name" minLength={3} maxLength={80} required /></label>
          <label>Purpose<textarea name="description" minLength={10} maxLength={500} required /></label>
          <label>Who can read?<select name="visibility"><option value="members">Members only</option><option value="cohort">Whole cohort</option></select></label>
          <button className="button button-primary" disabled={busy}>Create group</button>
        </form></details>
      </aside>
      <div className={styles.feed}>
        {selected ? <div className={styles.groupHead}><div><h3>{selected.name}</h3><p>{selected.description}</p></div><span className={styles.pill}>{selected.visibility === "members" ? <LockKeyhole size={13} /> : <Users size={13} />}{selected.visibility === "members" ? "Members only" : "Cohort"}</span></div> : null}
        {selected && ["owner", "moderator"].includes(selected.membershipRole ?? "") && selected.visibility === "members" && people.length ? <details className={styles.createPanel}><summary><Users size={15} /> Add a learner</summary><form onSubmit={(event) => void addMember(event)}><label>Learner<select name="learnerPublicId" required>{people.map((person) => <option key={person.publicId} value={person.publicId}>{person.alias}</option>)}</select></label><button className="button button-secondary" disabled={busy}>Add member</button></form></details> : null}
        {selected && selected.status === "active" ? <details className={styles.createPanel} open={visiblePosts.length === 0}><summary><Plus size={15} /> Start a conversation</summary><form onSubmit={(event) => void createPost(event)}>
          <div className={styles.formRow}><label>Type<select name="kind"><option value="discussion">Discussion</option><option value="help">Help request</option><option value="project_share">Project share</option></select></label><label>Title<input name="title" minLength={3} maxLength={160} required /></label></div>
          <label>What do you want the group to know?<textarea name="body" minLength={10} maxLength={8000} required /></label>
          <p className={styles.helper}>Plain text only. Do not paste API keys, passwords, private test answers, or personal contact details.</p>
          <button className="button button-primary" disabled={busy}><Send size={15} /> Post</button>
        </form></details> : null}
        {visiblePosts.length ? visiblePosts.map((post) => <article className={styles.post} key={post.id}>
          <div className={styles.postMeta}><span className={styles.kind}>{post.kind.replace("_", " ")}</span><span>{post.authorAlias} · {formatTime(post.createdAt)}{post.editedAt ? " · edited" : ""}</span></div>
          {editing?.id === post.id ? <form className={styles.editForm} onSubmit={(event) => void saveEdit(event)}><label>Title<input value={editing.title} onChange={(event) => setEditing({ ...editing, title: event.target.value })} /></label><label>Post<textarea value={editing.body} onChange={(event) => setEditing({ ...editing, body: event.target.value })} /></label><div><button className="button button-primary">Save edit</button><button type="button" className="button button-secondary" onClick={() => setEditing(null)}>Cancel</button></div></form> : <><h3>{post.title}</h3><p className={styles.body}>{post.body}</p></>}
          <div className={styles.actions}><button type="button" onClick={() => setReplying(replying === post.id ? null : post.id)}><MessageCircle size={14} /> Reply</button>{post.own && <><button type="button" onClick={() => setEditing({ target: "post", id: post.id, version: post.rowVersion, title: post.title, body: post.body })}><Pencil size={14} /> Edit</button><button type="button" onClick={() => void mutate({ action: "delete", target: "post", targetId: post.id, expectedVersion: post.rowVersion }, "Post removed from the cohort feed.")}><Trash2 size={14} /> Delete</button></>}<ReportControl target="post" targetId={post.id} onDone={setNotice} /></div>
          {replying === post.id && <form className={styles.replyForm} onSubmit={(event) => void reply(event)}><label htmlFor={`reply-${post.id}`}>Your reply</label><textarea id={`reply-${post.id}`} value={replyBody} minLength={2} maxLength={4000} onChange={(event) => setReplyBody(event.target.value)} required /><button className="button button-primary" disabled={busy}>Post reply</button></form>}
          {post.replies.length ? <div className={styles.replies}>{post.replies.map((item) => <div className={styles.reply} key={item.id}>
            <div><strong>{item.authorAlias}</strong><small>{formatTime(item.createdAt)}{item.editedAt ? " · edited" : ""}</small></div>
            {editing?.id === item.id ? <form className={styles.editForm} onSubmit={(event) => void saveEdit(event)}><label>Reply<textarea value={editing.body} onChange={(event) => setEditing({ ...editing, body: event.target.value })} /></label><div><button className="button button-primary">Save</button><button type="button" className="button button-secondary" onClick={() => setEditing(null)}>Cancel</button></div></form> : <p className={styles.body}>{item.body}</p>}
            <div className={styles.actions}>{item.own && <><button type="button" onClick={() => setEditing({ target: "reply", id: item.id, version: item.rowVersion, title: "", body: item.body })}><Pencil size={13} /> Edit</button><button type="button" onClick={() => void mutate({ action: "delete", target: "reply", targetId: item.id, expectedVersion: item.rowVersion }, "Reply removed from the cohort feed.")}><Trash2 size={13} /> Delete</button></>}<ReportControl target="reply" targetId={item.id} onDone={setNotice} /></div>
          </div>)}</div> : null}
        </article>) : <div className={styles.state}><MessageCircle size={24} /><h3>No conversations in this group</h3><p>Start with one specific question, useful explanation, or project milestone.</p></div>}
        {discussion.nextCursor && <button type="button" className="button button-secondary" onClick={() => loadSafely(selectedGroup, true, discussion.nextCursor)}>Load older conversations</button>}
      </div>
      {discussion.moderation && <aside className={styles.moderation}><div className={styles.railTitle}><ShieldCheck size={17} /><strong>Moderation queue</strong></div>{reports.filter((report) => report.status === "open").length ? reports.filter((report) => report.status === "open").map((report) => <article key={report.id}><span>{report.reason}</span><p>{report.excerpt}</p><small>{formatTime(report.createdAt)}</small><div><button type="button" onClick={() => void moderate(report, "hide")} disabled={busy}>Hide content</button><button type="button" onClick={() => void moderate(report, "restore")} disabled={busy}>Dismiss report</button></div></article>) : <div className={styles.miniEmpty}><ShieldCheck size={20} /><p>No open reports.</p></div>}</aside>}
    </div>}

    {tab === "battle" && <div className={styles.battleLayout} id="community-panel-battle" role="tabpanel" aria-labelledby="community-tab-battle">
      <aside className={styles.battleRail}>
        <div className={styles.railTitle}><Trophy size={17} /><strong>Challenge board</strong></div>
        <label>Show<select value={battleFilter} onChange={(event) => setBattleFilter(event.target.value as typeof battleFilter)}><option value="all">All battles</option><option value="invite">Friend invites</option><option value="cohort">Cohort</option><option value="weekly">Weekly competition</option><option value="monthly">Monthly competition</option></select></label>
        {phone && <div className={styles.mobileNotice}><LockKeyhole size={17} /><span><strong>Read-only on phone</strong><small>Create, join, and submit on a tablet or laptop.</small></span></div>}
        {!phone && battles.sources.length ? <details className={styles.createPanel}><summary><Plus size={15} /> Create a battle</summary><form onSubmit={(event) => void createBattle(event)}>
          <label>Reviewed challenge<select name="activityId" required>{battles.sources.map((source) => <option key={source.activityId} value={source.activityId}>{source.title} · {source.language}</option>)}</select></label>
          <label>Scope<select name="scope" defaultValue="invite"><option value="invite">Invite one friend</option><option value="cohort">Open cohort challenge</option>{discussion.moderation && <><option value="weekly">Weekly competition (admin)</option><option value="monthly">Monthly competition (admin)</option></>}</select></label>
          <label>Friend<select name="invite"><option value="">Choose for invite scope</option>{people.map((person) => <option key={person.publicId} value={person.publicId}>{person.alias}</option>)}</select></label>
          <label>Normal battle minutes<input name="durationMinutes" type="number" min={5} max={1440} defaultValue={60} /></label>
          {discussion.moderation && <label>Competition key<input name="competitionKey" placeholder="2026-W29 or 2026-07" /></label>}
          <button className="button button-primary" disabled={busy}>Freeze reviewed challenge</button>
        </form></details> : !phone ? <div className={styles.miniEmpty}><p>No human-reviewed challenge sources are published yet.</p><small>Battles fail closed instead of generating an unreviewed question.</small></div> : null}
        <div className={styles.fairness}><ShieldCheck size={16} /><p>{battles.scoring.rule}</p><small>{battles.scoring.reveal}</small></div>
      </aside>
      <div className={styles.battleList}>
        {filteredBattles.length ? filteredBattles.map((battle) => <article className={styles.battleCard} key={battle.id}>
          <div className={styles.battleTop}><span className={styles.kind}>{battle.scope}</span><span className={styles.status}>{battle.status}</span></div>
          <h3>{battle.title}</h3><p>{battle.prompt?.instructions ?? `Challenge details unlock ${formatTime(battle.startsAt)}.`}</p>
          <div className={styles.battleFacts}><span><Gamepad2 size={14} /> {battle.language}</span><span><Users size={14} /> {battle.participantCount} joined</span><span><CalendarClock size={14} /> reveal {formatTime(battle.revealAt)}</span></div>
          <p className={styles.helper}>{battle.limitations}</p>
          <div className={styles.actions}><button type="button" onClick={() => void requestJson<BattleDetail>(`/api/battles/${battle.id}`).then(setDetail).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Battle details unavailable."))}>View challenge</button>{battle.canJoin && !phone && <button type="button" onClick={() => void battleAction(battle.id, { action: "join" }, "Battle joined. Your work remains independent.")}>Join</button>}</div>
          {detail?.battle.id === battle.id && <div className={styles.battleDetail}>
            {detail.resultsRevealed ? <div><h4>Revealed results</h4>{detail.results.length ? <ol>{detail.results.map((result, index) => <li key={`${result.rank}-${index}`}><strong>#{result.rank} {result.alias}</strong><span>{result.score}/{battle.maxPoints}{result.passed ? " · passed" : ""}</span></li>)}</ol> : <p>No valid submissions.</p>}</div> : <div className={styles.hiddenResult}><LockKeyhole size={18} /><span><strong>Results are sealed</strong><small>Scores and rankings appear only after the server reveal time.</small></span></div>}
            {!phone && battle.participant && battle.status === "open" && !battle.submitted && battle.prompt && <form onSubmit={(event) => void submitBattleAnswer(event, battle)}>
              <BattleAnswerFields battle={battle} />
              <button className="button button-primary" disabled={busy}>Submit once</button><p className={styles.helper}>Final submission. No AI help or answer reveal is available inside a battle.</p>
            </form>}
          </div>}
        </article>) : <div className={styles.state}><Trophy size={24} /><h3>No battles match this filter</h3><p>Create one from a reviewed activity, or choose another competition period.</p></div>}
      </div>
    </div>}
  </section>;
}
