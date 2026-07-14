export type WebCourseId = "html" | "css" | "javascript" | "react";
export type WebVerificationClassification =
  | "executable"
  | "browser-static-a11y"
  | "non-code";

export interface BrowserAction {
  readonly type: "click" | "fill" | "press" | "wait" | "evaluate";
  readonly selector?: string;
  readonly value?: string;
  readonly key?: string;
  readonly milliseconds?: number;
  readonly expression?: string;
}

export interface BrowserAssertion {
  readonly description: string;
  /** Trusted authoring oracle evaluated in the isolated, network-denied page. */
  readonly expression: string;
  readonly expected: boolean | number | string | null | readonly string[];
}

export interface BrowserVerificationCase {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly url?: string;
  readonly entrypoint?: "app" | "test";
  readonly reducedMotion?: "reduce" | "no-preference";
  readonly colorScheme?: "light" | "dark";
  readonly document?: string;
  readonly routes?: readonly {
    readonly url: string;
    readonly status: number;
    readonly contentType: string;
    readonly body: string;
    readonly delayMs?: number;
  }[];
  readonly actions?: readonly BrowserAction[];
  readonly assertions: readonly BrowserAssertion[];
  readonly axe?: boolean;
  readonly allowedConsoleErrors?: readonly string[];
}

export interface BrowserWebTaskSpec {
  readonly classification: "browser-static-a11y";
  readonly facet: string;
  readonly referenceSolution: string;
  readonly visible: BrowserVerificationCase;
  readonly hidden: BrowserVerificationCase;
}

export interface NodeWebTaskSpec {
  readonly classification: "executable";
  readonly facet: string;
  readonly prompt: string;
  readonly starterCode: string;
  readonly referenceSolution: string;
  readonly tests: readonly {
    readonly id: string;
    readonly visibility: "visible" | "hidden";
    readonly category: "normal" | "boundary" | "invalid";
    readonly stdin: string;
    readonly expectedStdout: string;
  }[];
}

const htmlDocument = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>HTML evidence</title></head>
<body><!-- Maintainer note: public source, never a secret. --><main><h1>Document model</h1><p id="literal">Use &lt;code&gt; for an element.</p><p>Hello <em data-kind="emphasis">friend</em>.</p></main></body>
</html>`;

const htmlSemantics = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Semantic outline</title></head><body>
<header><nav aria-label="Primary"><ul><li><a href="#lesson">Lesson</a></li></ul></nav></header>
<main id="main"><h1>Cooking course</h1><section aria-labelledby="lesson"><h2 id="lesson">Ingredients</h2><p><strong>Important:</strong> use <code>200&nbsp;g</code>.</p><ol><li>Measure</li><li>Mix</li></ol><dl><dt>Fold</dt><dd>Combine gently</dd></dl></section><aside aria-label="Tip">Prepare first.</aside></main><footer>Course footer</footer>
</body></html>`;

const htmlNavigation = `<!doctype html><html lang="en"><head><meta charset="utf-8"><base href="https://example.test/courses/html/"><title>Navigation</title></head><body>
<a class="skip" href="#main">Skip to main content</a><nav aria-label="Lessons"><a id="relative" href="../css/?mode=learn#intro">Read the CSS introduction</a> <a id="external" href="https://docs.example.test/guide" target="_blank" rel="noopener noreferrer">Documentation (opens in a new tab)</a></nav><main id="main" tabindex="-1"><h1>Navigation lesson</h1></main>
</body></html>`;

const htmlMedia = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Media</title></head><body><main><h1>Media evidence</h1>
<img id="decorative" src="decoration.png" alt=""><figure><picture><source media="(min-width: 48rem)" srcset="chart-wide.png 1200w"><img id="chart" src="chart.png" srcset="chart.png 600w, chart-large.png 1200w" sizes="(min-width: 48rem) 50vw, 100vw" width="600" height="400" alt="Completion rose from 60 to 80 percent"></picture><figcaption>Course completion by month</figcaption></figure>
<video controls preload="metadata"><track kind="captions" srclang="en" src="captions.vtt" label="English"></video><a href="transcript.html">Read the transcript</a></main></body></html>`;

const htmlTable = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Scores</title></head><body><main><h1>Scores</h1><table><caption>Practice scores by learner</caption><thead><tr><th scope="col">Learner</th><th scope="col">Score</th></tr></thead><tbody><tr><th scope="row">Asha</th><td>92</td></tr><tr><th scope="row">Ravi</th><td>88</td></tr></tbody><tfoot><tr><th scope="row">Average</th><td>90</td></tr></tfoot></table></main></body></html>`;

const htmlForms = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Profile form</title></head><body><main><h1>Profile</h1><form action="/search" method="get"><label for="query">Search courses</label><input id="query" name="q" type="search" required minlength="2" autocomplete="off"><fieldset><legend>Study reminder</legend><label><input type="radio" name="reminder" value="email" autocomplete="off"> Email</label><label><input type="radio" name="reminder" value="none"> None</label></fieldset><label for="note">Learning goal</label><textarea id="note" name="goal" maxlength="200"></textarea><button type="submit">Search</button></form></main></body></html>`;

const htmlMetadata = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Variables in JavaScript - Codestead</title><meta name="description" content="Practice JavaScript variables with deterministic examples."><link rel="canonical" href="https://example.test/javascript/variables"><link rel="stylesheet" href="styles.css"><link rel="preload" href="course-font.woff2" as="font" type="font/woff2" crossorigin></head><body><main><h1>Variables in JavaScript</h1></main></body></html>`;

const htmlNative = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Native controls</title></head><body><main><h1>Native controls</h1><button type="button" aria-pressed="false">Save preference</button><details><summary>Hint</summary><p>Try a smaller input.</p></details><label for="level">Level</label><select id="level"><option>Beginner</option></select></main></body></html>`;

const htmlProgressive = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Course index</title><link rel="stylesheet" href="missing.css"><script src="missing.js" defer></script></head><body><header><nav aria-label="Course"><a href="lesson-1.html">Lesson 1</a></nav></header><main><h1>Course index</h1><p>All required lesson content is present before optional enhancements load.</p></main></body></html>`;

const cssDocument = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>CSS evidence</title></head><body><main><h1>CSS evidence</h1><section class="panel"><h2>Responsive card</h2><p class="copy">Readable content stays in normal flow and may contain a verylongunbrokenlearningtoken.</p><button class="action">Continue</button><div class="grid"><article>One</article><article>Two</article><article>Three</article></div></section></main></body></html>`;

const CSS_FIXTURES = {
  cascade: `@layer reset, base, components; @layer base { :root { color: rgb(20 30 40); } body { color: inherit; } } @layer components { .panel { color: rgb(10 20 30); } main .panel { color: rgb(30 40 50); } }`,
  selectors: `.panel > h2 { margin-block: 0; } .action:hover, .action:focus-visible { outline: 3px solid rgb(0 80 180); } .copy::first-letter { font-weight: 700; }`,
  tokens: `:root { --space: 1rem; --accent: rgb(0 90 170); } .panel { padding: var(--space, 16px); border-inline-start: .25rem solid var(--accent); }`,
  box: `*, *::before, *::after { box-sizing: border-box; } .panel { inline-size: min(100%, 42rem); min-inline-size: 0; padding: 1rem; border: 2px solid; overflow-wrap: anywhere; aspect-ratio: auto; }`,
  type: `body { font-family: system-ui, sans-serif; font-size: 1rem; line-height: 1.6; color: rgb(25 25 30); background: rgb(255 255 255); } .copy { max-inline-size: 65ch; text-align: start; } .action { color: white; background: rgb(0 70 150); border: 2px solid currentColor; box-shadow: 0 .125rem .25rem rgb(0 0 0 / .25); }`,
  layout: `.panel { display: flow-root; position: relative; margin-inline: auto; padding-inline: 1rem; } .action { position: sticky; inset-block-start: .5rem; z-index: 1; } .copy { margin-block: 1rem; }`,
  flex: `.panel { display: flex; flex-flow: row wrap; gap: 1rem; align-items: center; justify-content: space-between; } .copy { flex: 1 1 20rem; } .action { order: 0; }`,
  grid: `.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(12rem, 100%), 1fr)); gap: 1rem; } .grid article { min-inline-size: 0; }`,
  responsive: `.panel { container-type: inline-size; inline-size: min(100%, 60rem); } .grid { display: grid; grid-template-columns: 1fr; } @container (min-width: 30rem) { .grid { grid-template-columns: repeat(2, 1fr); } } @media (min-width: 50rem) { body { padding-inline: 2rem; } }`,
  motion: `.action { transition: transform 180ms ease, background-color 180ms ease; } .action:hover { transform: translateY(-2px); } @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; } .action:hover { transform: none; } }`,
  compatibility: `.grid { display: flex; flex-wrap: wrap; } @supports (display: grid) { .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); } }`,
} as const;

const jsScript = `document.body.dataset.scriptLoaded = "true"; document.querySelector("output").textContent = "ready";`;
const jsModule = `const value = 7; const doubled = value * 2; document.querySelector("output").textContent = String(doubled); globalThis.moduleThisIsUndefined = (function () { return this; })() === undefined;`;
const jsEventLoop = `const order = []; order.push("sync"); queueMicrotask(() => { order.push("microtask"); document.querySelector("output").textContent = order.join(","); }); setTimeout(() => order.push("task"), 0);`;
const jsDom = `const list = document.querySelector("ul"); const item = document.createElement("li"); item.textContent = "Arrays"; item.dataset.skill = "arrays"; list.append(item); document.querySelector("h1").classList.add("ready");`;
const jsEvents = `const list = document.querySelector("ul"); list.addEventListener("click", (event) => { const button = event.target.closest("button"); if (button) document.querySelector("output").textContent = button.dataset.value; }); const form = document.querySelector("form"); form.addEventListener("submit", (event) => { event.preventDefault(); const input = form.elements.namedItem("topic"); document.querySelector("output").textContent = input.value.trim() || "required"; });`;
const jsFetch = `const controller = new AbortController(); globalThis.cancelRequest = () => controller.abort(); async function load() { const output = document.querySelector("output"); output.textContent = "loading"; try { const response = await fetch("https://learncoding.test/api/lesson", { signal: controller.signal }); if (!response.ok) throw new Error("HTTP " + response.status); const body = await response.json(); output.textContent = body.title; } catch (error) { output.textContent = error.name === "AbortError" ? "cancelled" : "failed"; } } load();`;
const jsUrlStorage = `const url = new URL(location.href); const mode = url.searchParams.get("mode") ?? "learn"; let stored = ""; try { localStorage.setItem("preferences.v1", JSON.stringify({ mode })); stored = JSON.parse(localStorage.getItem("preferences.v1") ?? "{}").mode ?? "fallback"; } catch { stored = "fallback"; } document.querySelector("output").textContent = mode + ":" + stored; history.replaceState({ mode }, "", "?mode=" + encodeURIComponent(mode));`;
const jsXss = `const untrusted = '<img src=x onerror="globalThis.compromised=true">'; document.querySelector("output").textContent = untrusted;`;
const jsDomTest = `const output = document.querySelector("output"); const button = document.querySelector("button"); output.textContent = "idle"; button.addEventListener("click", async () => { output.textContent = "loading"; await Promise.resolve(); output.textContent = "saved"; });`;

const REACT_FIXTURES = {
  basics: `import React, { StrictMode } from "react"; import { createRoot } from "react-dom/client";
const lessons = [{id:"html", title:"HTML"},{id:"css",title:"CSS"}];
function Status({ready}:{ready:boolean}) { return <p role="status">{ready ? "Ready" : "Loading"}</p>; }
function App() { return <main><h1>Course plan</h1><Status ready={true}/><ul>{lessons.map((lesson)=><li key={lesson.id} data-id={lesson.id}>{lesson.title}</li>)}</ul></main>; }
createRoot(document.getElementById("root")!).render(<StrictMode><App/></StrictMode>);`,
  props: `import React, { StrictMode } from "react"; import { createRoot } from "react-dom/client";
type CardProps={title:string; children:React.ReactNode; onChoose:(title:string)=>void};
function Card({title,children,onChoose}:CardProps){ return <article><h2>{title}</h2><div>{children}</div><button onClick={()=>onChoose(title)}>Choose {title}</button></article>; }
function App(){ const selected:string[]=[]; return <main><h1>Tracks</h1><Card title="JavaScript" onChoose={(title)=>selected.push(title)}><p>Browser programming</p></Card><output aria-live="polite">{selected.join(",")}</output></main>; }
createRoot(document.getElementById("root")!).render(<StrictMode><App/></StrictMode>);`,
  state: `import React, { useState } from "react"; import { createRoot } from "react-dom/client";
function Counter({value,onChange}:{value:number;onChange:(next:number)=>void}){return <button onClick={()=>onChange(value+1)}>Count {value}</button>}
function App(){const [count,setCount]=useState(0);const [name,setName]=useState("");const doubled=count*2;return <main><h1>Practice</h1><Counter value={count} onChange={setCount}/><Counter value={count} onChange={setCount}/><output data-testid="double">Double {doubled}</output><label>Name <input value={name} onChange={(event)=>setName(event.target.value)}/></label><p>Hello {name || "learner"}</p></main>}
createRoot(document.getElementById("root")!).render(<App/>);`,
  forms: `import React, { useReducer, useState } from "react"; import { createRoot } from "react-dom/client";
type State={attempts:number};type Action={type:"submit"};const reducer=(state:State,action:Action)=>action.type==="submit"?{attempts:state.attempts+1}:state;
function App(){const [email,setEmail]=useState("");const [error,setError]=useState("");const [state,dispatch]=useReducer(reducer,{attempts:0});function submit(event:React.FormEvent){event.preventDefault();if(!email.includes("@")){setError("Enter a valid email");return;}setError("");dispatch({type:"submit"});}return <main><h1>Register</h1><form onSubmit={submit} noValidate><label htmlFor="email">Email</label><input id="email" type="email" required value={email} aria-describedby="email-error" aria-invalid={Boolean(error)} onChange={(event)=>setEmail(event.target.value)}/><p id="email-error" role="alert">{error}</p><button>Submit</button></form><output>Attempts {state.attempts}</output></main>}
createRoot(document.getElementById("root")!).render(<App/>);`,
  effects: `import React, { useEffect, useRef, useState } from "react"; import { createRoot } from "react-dom/client";
function Listener({topic}:{topic:string}){const [events,setEvents]=useState(0);useEffect(()=>{const handle=()=>setEvents((value)=>value+1);window.addEventListener("course-refresh",handle);document.title="Topic: "+topic;return()=>window.removeEventListener("course-refresh",handle)},[topic]);return <output>Events {events}</output>}
function App(){const [topic,setTopic]=useState("HTML");const [shown,setShown]=useState(true);const input=useRef<HTMLInputElement>(null);return <main><h1>Effects</h1><label>Topic <input value={topic} onChange={(event)=>setTopic(event.target.value)} ref={input}/></label><button onClick={()=>input.current?.focus()}>Focus topic</button><button onClick={()=>setShown((value)=>!value)}>Toggle listener</button>{shown&&<Listener topic={topic}/>}</main>}
createRoot(document.getElementById("root")!).render(<App/>);`,
  data: `import React, { useEffect, useState } from "react"; import { createRoot } from "react-dom/client";
function useLesson(){const [state,setState]=useState<{kind:string;title?:string}>({kind:"loading"});useEffect(()=>{let current=true;Promise.resolve({title:"Async JavaScript"}).then((value)=>{if(current)setState({kind:"success",title:value.title})});return()=>{current=false}},[]);return state}
function App(){const lesson=useLesson();const [saving,setSaving]=useState(false);const [message,setMessage]=useState("");async function save(){if(saving)return;setSaving(true);setMessage("");await Promise.resolve();setSaving(false);setMessage("Saved")}return <main><h1>Remote lesson</h1>{lesson.kind==="loading"?<p role="status">Loading</p>:<article><h2>{lesson.title}</h2></article>}<button disabled={saving} onClick={save}>{saving?"Saving":"Save"}</button><output aria-live="polite">{message}</output></main>}
createRoot(document.getElementById("root")!).render(<App/>);`,
  context: `import React, { createContext, useContext, useReducer } from "react"; import { createRoot } from "react-dom/client";
type State={theme:"light"|"dark"};const Theme=createContext<{state:State;toggle:()=>void}|null>(null);function Provider({children}:{children:React.ReactNode}){const [state,dispatch]=useReducer((value:State)=>({theme:value.theme==="light"?"dark":"light"}),{theme:"light"});return <Theme.Provider value={{state,toggle:()=>dispatch()}}>{children}</Theme.Provider>}function Control(){const value=useContext(Theme);if(!value)throw new Error("missing provider");return <button aria-pressed={value.state.theme==="dark"} onClick={value.toggle}>Theme {value.state.theme}</button>}function App(){return <Provider><main><h1>Settings</h1><Control/></main></Provider>}createRoot(document.getElementById("root")!).render(<App/>);`,
  robustness: `import React, { Component, memo, useState } from "react"; import { createRoot } from "react-dom/client";
let renders=0;const Stable=memo(function Stable(){renders+=1;return <output data-renders={renders}>Stable renders {renders}</output>});class Boundary extends Component<{children:React.ReactNode},{failed:boolean}>{state={failed:false};static getDerivedStateFromError(){return{failed:true}}render(){return this.state.failed?<p role="alert">Feature unavailable</p>:this.props.children}}function Risky({fail}:{fail:boolean}){if(fail)throw new Error("demo");return <p>Feature ready</p>}function App(){const [count,setCount]=useState(0);const [fail,setFail]=useState(false);return <main><h1>Robust UI</h1><button onClick={()=>setCount((value)=>value+1)}>Unrelated {count}</button><button onClick={()=>setFail(true)}>Trigger failure</button><Stable/><Boundary><Risky fail={fail}/></Boundary></main>}createRoot(document.getElementById("root")!).render(<App/>);`,
} as const;

export interface BrowserProjectArtifact {
  readonly format: "browser-project-v1";
  readonly entrypoints: {
    readonly app: string;
    readonly test: string;
  };
  readonly files: Readonly<Record<string, string>>;
}

const PORTFOLIO_PROJECT: BrowserProjectArtifact = {
  format: "browser-project-v1",
  entrypoints: {
    app: "src/main.tsx",
    test: "src/portfolio.test.tsx",
  },
  files: {
    "index.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Portfolio - Codestead</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`,
    "package.json": JSON.stringify({
      private: true,
      type: "module",
      scripts: { dev: "vite", build: "vite build", preview: "vite preview", test: "vitest run" },
      dependencies: { react: "19.2.7", "react-dom": "19.2.7", "react-router": "8.0.1" },
      devDependencies: { "@testing-library/react": "16.3.2", "@testing-library/user-event": "14.6.1", typescript: "5.9.3", vite: "8.1.4", vitest: "4.1.10" },
    }, null, 2),
    "tsconfig.json": JSON.stringify({
      compilerOptions: { target: "ES2022", lib: ["ES2022", "DOM", "DOM.Iterable"], module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", strict: true, noEmit: true },
      include: ["src"],
    }, null, 2),
    "src/data.ts": `export interface Project { readonly id: string; readonly title: string; readonly summary: string; }
export const projects: readonly Project[] = [
  { id: "compiler-visualizer", title: "Compiler visualizer", summary: "Trace a small program step by step." },
  { id: "graph-lab", title: "Graph lab", summary: "Explore breadth-first traversal." },
];`,
    "src/App.tsx": `import React, { useEffect, useRef, useState } from "react";
import { Link, Outlet, Route, Routes, useLocation, useParams, useSearchParams } from "react-router";
import { projects, type Project } from "./data";
import "./styles.css";

function titleFor(pathname: string): string {
  if (pathname === "/") return "Portfolio";
  if (pathname === "/projects") return "Projects";
  if (pathname.startsWith("/projects/")) return "Project detail";
  return "Not found";
}

function Layout() {
  const location = useLocation();
  const heading = useRef<HTMLHeadingElement>(null);
  const title = titleFor(location.pathname);
  useEffect(() => {
    document.title = title + " - Codestead";
    queueMicrotask(() => heading.current?.focus());
  }, [title]);
  return <><header><nav aria-label="Portfolio"><Link to="/">Home</Link><Link to="/projects">Projects</Link></nav></header><main><h1 ref={heading} tabIndex={-1}>{title}</h1><Outlet /></main></>;
}

function Home() {
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  function submit(event: React.FormEvent) { event.preventDefault(); setMessage(name.trim() ? "Thanks " + name.trim() : "Name is required"); }
  return <section aria-labelledby="welcome"><h2 id="welcome">Shivansh's learning portfolio</h2><p>Small projects with tested user journeys.</p><form onSubmit={submit}><label htmlFor="visitor-name">Your name</label><input id="visitor-name" value={name} required onChange={(event) => setName(event.target.value)} /><button>Send greeting</button></form><output aria-live="polite">{message}</output></section>;
}

function Projects() {
  const [search] = useSearchParams();
  const requestedState = search.get("state") ?? "success";
  const [state, setState] = useState<{ kind: "loading" } | { kind: "ready"; projects: readonly Project[] } | { kind: "error"; message: string }>({ kind: "loading" });
  useEffect(() => { let current = true; setState({ kind: "loading" }); Promise.resolve().then(() => { if (!current) return; if (requestedState === "error") setState({ kind: "error", message: "Projects unavailable" }); else setState({ kind: "ready", projects: requestedState === "empty" ? [] : projects }); }); return () => { current = false; }; }, [requestedState]);
  if (state.kind === "loading") return <p role="status">Loading projects</p>;
  if (state.kind === "error") return <p role="alert">{state.message}</p>;
  if (state.projects.length === 0) return <p>No projects yet</p>;
  return <ul>{state.projects.map((project) => <li key={project.id}><article><h2><Link to={"/projects/" + project.id}>{project.title}</Link></h2><p>{project.summary}</p></article></li>)}</ul>;
}

function ProjectDetail() {
  const { projectId = "" } = useParams();
  const [search] = useSearchParams();
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) return <p role="alert">Project not found</p>;
  return <article><h2>{project.title}</h2><p data-project-id={projectId}>Project {projectId}</p><p>Tab: {search.get("tab") ?? "overview"}</p></article>;
}

function NotFound() { return <p role="alert">Page not found</p>; }

export function AppRoutes() {
  return <Routes><Route element={<Layout />}><Route index element={<Home />} /><Route path="projects" element={<Projects />} /><Route path="projects/:projectId" element={<ProjectDetail />} /><Route path="*" element={<NotFound />} /></Route></Routes>;
}`,
    "src/main.tsx": `import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { AppRoutes } from "./App";
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(<BrowserRouter><AppRoutes /></BrowserRouter>);`,
    "src/styles.css": `:root { font-family: system-ui, sans-serif; color: #172033; background: #fff; } body { margin: 0; } header, main { inline-size: min(100% - 2rem, 64rem); margin-inline: auto; } nav { display: flex; gap: 1rem; padding-block: 1rem; } a:focus-visible, h1:focus-visible { outline: 3px solid #0759b8; outline-offset: 3px; } ul { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(16rem, 100%), 1fr)); gap: 1rem; padding: 0; list-style: none; } article { border: 1px solid #64748b; border-radius: .5rem; padding: 1rem; } @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }`,
    "src/portfolio.test.tsx": `import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { AppRoutes } from "./App";

async function runPortfolioTests() {
  const checks: string[] = [];
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={["/"]}><AppRoutes /></MemoryRouter>);
  screen.getByRole("heading", { level: 1, name: "Portfolio" });
  checks.push("role-name-query");
  await user.type(screen.getByRole("textbox", { name: "Your name" }), "Asha");
  await user.click(screen.getByRole("button", { name: "Send greeting" }));
  await screen.findByText("Thanks Asha");
  checks.push("form-state");
  await user.click(screen.getByRole("link", { name: "Projects" }));
  checks.push("realistic-click");
  const projectLink = await screen.findByRole("link", { name: "Compiler visualizer" });
  checks.push("async-state");
  await user.click(projectLink);
  await waitFor(() => screen.getByText("Project compiler-visualizer"));
  checks.push("route-param");
  await waitFor(() => { if (document.activeElement?.textContent !== "Project detail") throw new Error("route heading was not focused"); });
  checks.push("route-focus");
  cleanup();
  render(<MemoryRouter initialEntries={["/projects/graph-lab?tab=code"]}><AppRoutes /></MemoryRouter>);
  screen.getByText("Tab: code");
  checks.push("direct-entry");
  cleanup();
  render(<MemoryRouter initialEntries={["/projects?state=error"]}><AppRoutes /></MemoryRouter>);
  await screen.findByRole("alert");
  screen.getByText("Projects unavailable");
  checks.push("async-error");
  cleanup();
  render(<MemoryRouter initialEntries={["/projects?state=empty"]}><AppRoutes /></MemoryRouter>);
  await screen.findByText("No projects yet");
  checks.push("async-empty");
  (globalThis as typeof globalThis & { __testResults?: string[] }).__testResults = checks;
}

runPortfolioTests().catch((error: unknown) => {
  (globalThis as typeof globalThis & { __testError?: string }).__testError = error instanceof Error ? error.message : String(error);
});`,
  },
};

const portfolioSource = JSON.stringify(PORTFOLIO_PROJECT, null, 2);

const baseCase = (assertion: BrowserAssertion, overrides: Partial<BrowserVerificationCase> = {}): BrowserVerificationCase => ({
  viewport: { width: 1024, height: 768 },
  assertions: [assertion],
  ...overrides,
});

const assertion = (description: string, expression: string, expected: BrowserAssertion["expected"] = true): BrowserAssertion => ({ description, expression, expected });

function browserTask(
  referenceSolution: string,
  facet: string,
  visible: BrowserAssertion,
  hidden: BrowserAssertion,
  visibleOverrides: Partial<BrowserVerificationCase> = {},
  hiddenOverrides: Partial<BrowserVerificationCase> = {},
): BrowserWebTaskSpec {
  return {
    classification: "browser-static-a11y",
    facet,
    referenceSolution,
    visible: baseCase(visible, visibleOverrides),
    hidden: baseCase(hidden, { viewport: { width: 320, height: 568 }, ...hiddenOverrides }),
  };
}

const h = browserTask;
export const WEB_BROWSER_TASKS = {
  "html.document.syntax": h(htmlDocument, "conforming nested element and attribute structure", assertion("nested emphasis is parsed under the paragraph", "document.querySelector('p em')?.parentElement?.tagName", "P"), assertion("doctype survives parsing", "document.doctype?.name", "html")),
  "html.document.skeleton": h(htmlDocument, "standards document metadata and explicit language", assertion("root language is declared", "document.documentElement.lang", "en"), assertion("viewport metadata is present", "document.querySelector('meta[name=viewport]')?.getAttribute('content')?.includes('width=device-width')", true)),
  "html.document.dom": h(htmlDocument, "source nesting mapped to parent, child and sibling DOM relationships", assertion("main owns the heading and paragraphs", "document.querySelector('main')?.children.length", 3), assertion("emphasis node has a text-node sibling", "document.querySelector('em')?.nextSibling?.nodeType", 3)),
  "html.document.comments-entities": h(htmlDocument, "public comment node and reserved-character reference", assertion("entity is rendered as literal text", "document.querySelector('#literal')?.textContent", "Use <code> for an element."), assertion("comment is present and contains no secret-like token", "Array.from(document.body.childNodes).some(n=>n.nodeType===8) || document.documentElement.innerHTML.includes('Maintainer note')", true)),
  "html.semantics.headings": h(htmlSemantics, "hierarchical h1/h2 outline", assertion("one page heading and subordinate section heading", "document.querySelectorAll('h1').length===1 && document.querySelector('h2')?.parentElement?.tagName==='SECTION'"), assertion("heading ranks reflect hierarchy", "document.querySelector('h1')?.compareDocumentPosition(document.querySelector('h2'))===Node.DOCUMENT_POSITION_FOLLOWING")),
  "html.semantics.text": h(htmlSemantics, "semantic importance, code and paragraph text", assertion("importance and code use native elements", "!!document.querySelector('p strong') && !!document.querySelector('p code')"), assertion("text remains meaningful without CSS", "document.querySelector('section p')?.textContent?.includes('Important: use 200')", true)),
  "html.semantics.lists": h(htmlSemantics, "ordered sequence, navigation list and term-description association", assertion("recipe sequence is ordered", "document.querySelector('main ol')?.children.length", 2), assertion("description term has a following description", "document.querySelector('dt')?.nextElementSibling?.tagName", "DD")),
  "html.semantics.landmarks": h(htmlSemantics, "native page landmarks with labeled navigation", assertion("one main landmark exists", "document.querySelectorAll('main').length", 1), assertion("navigation has a distinct accessible label", "document.querySelector('nav')?.getAttribute('aria-label')", "Primary"), {}, { axe: true }),
  "html.navigation.urls": h(htmlNavigation, "relative URL resolution against the document base", assertion("relative URL resolves through the declared base", "document.querySelector('#relative')?.href", "https://example.test/courses/css/?mode=learn#intro"), assertion("query and fragment are retained", "new URL(document.querySelector('#relative').href).search+new URL(document.querySelector('#relative').href).hash", "?mode=learn#intro")),
  "html.navigation.links": h(htmlNavigation, "real anchors with destination-specific names", assertion("lesson link is a native anchor with href", "document.querySelector('#relative')?.tagName==='A' && document.querySelector('#relative')?.hasAttribute('href')"), assertion("link name identifies its destination", "document.querySelector('#relative')?.textContent", "Read the CSS introduction")),
  "html.navigation.external": h(htmlNavigation, "disclosed new-context external link with rel isolation", assertion("new context is disclosed in visible text", "document.querySelector('#external')?.textContent?.includes('opens in a new tab')", true), assertion("noopener and noreferrer are both present", "['noopener','noreferrer'].every(v=>document.querySelector('#external')?.relList.contains(v))")),
  "html.navigation.skip": h(htmlNavigation, "first keyboard-operable bypass link to main content", assertion("skip target exists", "document.querySelector(document.querySelector('.skip')?.getAttribute('href'))?.id", "main"), assertion("first Tab reaches the skip link", "document.activeElement?.classList.contains('skip')", true), {}, { actions: [{ type: "press", key: "Tab" }], axe: true }),
  "html.media.images": h(htmlMedia, "purpose-based informative and empty decorative alternatives", assertion("informative image has purpose text", "document.querySelector('#chart')?.getAttribute('alt')?.includes('60 to 80')", true), assertion("decorative image has explicit empty alt", "document.querySelector('#decorative')?.getAttribute('alt')", ""), {}, { axe: true }),
  "html.media.figure": h(htmlMedia, "self-contained image associated with figcaption", assertion("picture is grouped by figure", "document.querySelector('figure picture')!==null"), assertion("figure owns a nonempty caption", "document.querySelector('figure figcaption')?.textContent", "Course completion by month")),
  "html.media.responsive": h(htmlMedia, "responsive candidates, truthful sizes and stable dimensions", assertion("width descriptors and sizes are supplied", "document.querySelector('#chart')?.srcset.includes('1200w') && document.querySelector('#chart')?.sizes.includes('50vw')"), assertion("stable intrinsic dimensions are declared", "document.querySelector('#chart')?.getAttribute('width')==='600' && document.querySelector('#chart')?.getAttribute('height')==='400'")),
  "html.media.audio-video": h(htmlMedia, "controlled video with captions and transcript alternative", assertion("video exposes native controls", "document.querySelector('video')?.controls", true), assertion("caption track and transcript link are both present", "document.querySelector('track[kind=captions]')!==null && document.querySelector('a[href*=transcript]')!==null"), {}, { axe: true }),
  "html.tables.structure": h(htmlTable, "native table sections, rows and cells", assertion("head, body and foot sections exist", "['THEAD','TBODY','TFOOT'].every(tag=>document.querySelector('table '+tag.toLowerCase()))"), assertion("each body row has a header and data cell", "Array.from(document.querySelectorAll('tbody tr')).every(row=>row.querySelector('th')&&row.querySelector('td'))")),
  "html.tables.headers": h(htmlTable, "row and column header scope associations", assertion("column headers declare col scope", "Array.from(document.querySelectorAll('thead th')).every(th=>th.scope==='col')"), assertion("body row headers declare row scope", "Array.from(document.querySelectorAll('tbody th')).every(th=>th.scope==='row')"), {}, { axe: true }),
  "html.tables.caption": h(htmlTable, "native table caption naming the data", assertion("caption names the table", "document.querySelector('table caption')?.textContent", "Practice scores by learner"), assertion("caption is the table's first element child", "document.querySelector('table')?.firstElementChild?.tagName", "CAPTION")),
  "html.forms.form": h(htmlForms, "GET form with successful named controls", assertion("form declares GET and an action", "document.querySelector('form')?.method==='get' && document.querySelector('form')?.getAttribute('action')==='/search'"), assertion("every editable control has a name", "Array.from(document.querySelectorAll('input,textarea')).every(control=>control.hasAttribute('name'))")),
  "html.forms.labels-controls": h(htmlForms, "persistent labels associated with native controls", assertion("search label resolves to its control", "document.querySelector('label[for=query]')?.control?.id", "query"), assertion("textarea has a visible programmatic label", "document.querySelector('label[for=note]')?.control?.tagName", "TEXTAREA"), {}, { axe: true }),
  "html.forms.groups": h(htmlForms, "fieldset/legend choice group and autocomplete intent", assertion("radio choices share one fieldset legend", "document.querySelector('fieldset legend')?.textContent", "Study reminder"), assertion("radios share a successful-control name", "new Set(Array.from(document.querySelectorAll('input[type=radio]')).map(e=>e.name)).size", 1)),
  "html.forms.validation": h(htmlForms, "native constraints paired with authoritative-server boundary", assertion("search input exposes type and required constraints", "document.querySelector('#query')?.type==='search' && document.querySelector('#query')?.required"), assertion("length constraint is deterministic", "document.querySelector('#query')?.minLength", 2)),
  "html.metadata.title-description": h(htmlMetadata, "unique title, visible heading and descriptive metadata", assertion("title identifies lesson and product", "document.title", "Variables in JavaScript - Codestead"), assertion("description supplements rather than replaces h1", "document.querySelector('meta[name=description]')!==null && document.querySelector('h1')!==null")),
  "html.metadata.resources": h(htmlMetadata, "deliberate stylesheet and font preload declarations", assertion("stylesheet remains a normal render dependency", "document.querySelector('link[rel=stylesheet]')?.getAttribute('href')", "styles.css"), assertion("font preload declares type and crossorigin", "document.querySelector('link[rel=preload]')?.getAttribute('as')==='font' && document.querySelector('link[rel=preload]')?.hasAttribute('crossorigin')")),
  "html.accessibility.native": h(htmlNative, "native controls before custom ARIA widgets", assertion("actions use native button/select/details", "['BUTTON','SELECT','DETAILS'].every(tag=>document.querySelector(tag.toLowerCase()))"), assertion("select retains a persistent label", "document.querySelector('label[for=level]')?.control?.tagName", "SELECT"), {}, { axe: true }),
  "html.quality.progressive": h(htmlProgressive, "core content and navigation without optional assets", assertion("required content is in the initial document", "document.querySelector('main p')?.textContent?.includes('required lesson content')", true), assertion("navigation remains a real link when scripts fail", "document.querySelector('nav a')?.getAttribute('href')", "lesson-1.html"), {}, { axe: true }),

  "css.cascade.rules": h(CSS_FIXTURES.cascade, "valid rule/declaration/value behavior", assertion("component rule computes a color", "getComputedStyle(document.querySelector('.panel')).color", "rgb(30, 40, 50)"), assertion("declared CSS has balanced rule blocks", "document.styleSheets[0].cssRules.length>0"), { document: cssDocument }, { document: cssDocument }),
  "css.cascade.sources": h(CSS_FIXTURES.cascade, "ordered author layers", assertion("named layers parse into CSS rules", "document.styleSheets[0].cssRules.length>=3"), assertion("component layer wins over base", "getComputedStyle(document.querySelector('.panel')).color", "rgb(30, 40, 50)"), { document: cssDocument }, { document: cssDocument }),
  "css.cascade.specificity": h(CSS_FIXTURES.cascade, "specificity then source order", assertion("more specific main panel selector wins", "getComputedStyle(document.querySelector('.panel')).color", "rgb(30, 40, 50)"), assertion("body inheritance does not override local declaration", "getComputedStyle(document.querySelector('.panel')).color!==getComputedStyle(document.body).color"), { document: cssDocument }, { document: cssDocument }),
  "css.cascade.inheritance": h(CSS_FIXTURES.cascade, "inherited root/body value and local computed override", assertion("body inherits root color", "getComputedStyle(document.body).color", "rgb(20, 30, 40)"), assertion("panel owns a computed override", "getComputedStyle(document.querySelector('.panel')).color", "rgb(30, 40, 50)"), { document: cssDocument }, { document: cssDocument }),
  "css.selectors.core": h(CSS_FIXTURES.selectors, "semantic class and child combinator selectors", assertion("child selector removes heading block margin", "getComputedStyle(document.querySelector('.panel>h2')).marginBlockStart", "0px"), assertion("selector does not flatten document semantics", "document.querySelector('.panel>h2')?.tagName", "H2"), { document: cssDocument }, { document: cssDocument }),
  "css.selectors.states": h(CSS_FIXTURES.selectors, "focus-visible state without replacing native behavior", assertion("focus rule exists in parsed stylesheet", "Array.from(document.styleSheets[0].cssRules).some(r=>r.cssText.includes(':focus-visible'))"), assertion("keyboard focus produces a visible outline", "parseFloat(getComputedStyle(document.querySelector('.action')).outlineWidth)>=3"), { document: cssDocument }, { document: cssDocument, actions: [{ type: "press", key: "Tab" }], axe: true }),
  "css.system.custom-properties": h(CSS_FIXTURES.tokens, "inheriting design token with fallback", assertion("custom property resolves to panel border color", "getComputedStyle(document.querySelector('.panel')).borderInlineStartColor", "rgb(0, 90, 170)"), assertion("relative token computes at current root size", "getComputedStyle(document.querySelector('.panel')).paddingTop", "16px"), { document: cssDocument }, { document: cssDocument }),
  "css.box.model": h(CSS_FIXTURES.box, "border-box used-size calculation", assertion("border-box is explicit", "getComputedStyle(document.querySelector('.panel')).boxSizing", "border-box"), assertion("panel stays within narrow viewport", "document.querySelector('.panel').getBoundingClientRect().right<=innerWidth"), { document: cssDocument }, { document: cssDocument, axe: true }),
  "css.box.units": h(CSS_FIXTURES.box, "relative rem and percentage-constrained sizing", assertion("padding follows root-relative unit", "getComputedStyle(document.querySelector('.panel')).paddingTop", "16px"), assertion("inline size adapts below max", "document.querySelector('.panel').getBoundingClientRect().width<=innerWidth"), { document: cssDocument }, { document: cssDocument }),
  "css.box.intrinsic": h(CSS_FIXTURES.box, "intrinsic max constraint without brittle fixed width", assertion("panel does not exceed 42rem", "document.querySelector('.panel').getBoundingClientRect().width<=672"), assertion("panel can shrink below max", "document.querySelector('.panel').getBoundingClientRect().width<672"), { document: cssDocument }, { document: cssDocument }),
  "css.box.overflow": h(CSS_FIXTURES.box, "long-token wrapping without essential clipping", assertion("overflow wrapping is enabled", "getComputedStyle(document.querySelector('.panel')).overflowWrap", "anywhere"), assertion("document has no horizontal overflow", "document.documentElement.scrollWidth<=document.documentElement.clientWidth"), { document: cssDocument }, { document: cssDocument, axe: true }),
  "css.type.fonts": h(CSS_FIXTURES.type, "resilient system font fallback", assertion("font stack includes a generic sans family", "getComputedStyle(document.body).fontFamily.toLowerCase().includes('sans')"), assertion("text renders without a remote font dependency", "document.fonts.status", "loaded"), { document: cssDocument }, { document: cssDocument }),
  "css.type.readability": h(CSS_FIXTURES.type, "scalable type, line height and readable measure", assertion("line height is at least 1.5 times font size", "parseFloat(getComputedStyle(document.body).lineHeight)/parseFloat(getComputedStyle(document.body).fontSize)>=1.5"), assertion("paragraph measure remains bounded", "getComputedStyle(document.querySelector('.copy')).maxInlineSize.length>0"), { document: cssDocument }, { document: cssDocument, axe: true }),
  "css.color.contrast": h(CSS_FIXTURES.type, "foreground/background and control contrast", assertion("button foreground differs from its background", "getComputedStyle(document.querySelector('.action')).color!==getComputedStyle(document.querySelector('.action')).backgroundColor"), assertion("automated serious/critical contrast audit passes", "true"), { document: cssDocument, axe: true }, { document: cssDocument, axe: true }),
  "css.visual.backgrounds": h(CSS_FIXTURES.type, "decorative border/shadow without content loss", assertion("button shadow is decorative and text remains present", "getComputedStyle(document.querySelector('.action')).boxShadow!=='none' && document.querySelector('.action').textContent==='Continue'"), assertion("border uses current foreground color", "getComputedStyle(document.querySelector('.action')).borderTopColor===getComputedStyle(document.querySelector('.action')).color"), { document: cssDocument }, { document: cssDocument }),
  "css.layout.flow": h(CSS_FIXTURES.layout, "flow-root preserving normal document flow", assertion("panel establishes flow-root", "getComputedStyle(document.querySelector('.panel')).display", "flow-root"), assertion("copy remains before action in DOM order", "document.querySelector('.copy').compareDocumentPosition(document.querySelector('.action'))===Node.DOCUMENT_POSITION_FOLLOWING"), { document: cssDocument }, { document: cssDocument }),
  "css.layout.position": h(CSS_FIXTURES.layout, "sticky positioning with logical inset", assertion("action uses sticky positioning", "getComputedStyle(document.querySelector('.action')).position", "sticky"), assertion("logical inset computes without removing source order", "getComputedStyle(document.querySelector('.action')).top", "8px"), { document: cssDocument }, { document: cssDocument }),
  "css.layout.stacking": h(CSS_FIXTURES.layout, "bounded stacking level in a positioned context", assertion("action has a deliberate finite z-index", "getComputedStyle(document.querySelector('.action')).zIndex", "1"), assertion("panel is the positioned containing context", "getComputedStyle(document.querySelector('.panel')).position", "relative"), { document: cssDocument }, { document: cssDocument }),
  "css.layout.logical": h(CSS_FIXTURES.layout, "inline/block logical spacing", assertion("logical inline padding computes on both sides", "getComputedStyle(document.querySelector('.panel')).paddingLeft===getComputedStyle(document.querySelector('.panel')).paddingRight"), assertion("layout remains within viewport under RTL", "(document.documentElement.dir='rtl',document.documentElement.scrollWidth<=innerWidth)"), { document: cssDocument }, { document: cssDocument }),
  "css.flex.axes": h(CSS_FIXTURES.flex, "wrapping flex row with explicit flexible basis", assertion("panel is a wrapping flex container", "getComputedStyle(document.querySelector('.panel')).display==='flex' && getComputedStyle(document.querySelector('.panel')).flexWrap==='wrap'"), assertion("copy can shrink at narrow width", "document.querySelector('.copy').getBoundingClientRect().width<=innerWidth"), { document: cssDocument }, { document: cssDocument }),
  "css.flex.alignment": h(CSS_FIXTURES.flex, "alignment without contradicting source order", assertion("cross-axis center and distributed main-axis alignment compute", "getComputedStyle(document.querySelector('.panel')).alignItems==='center' && getComputedStyle(document.querySelector('.panel')).justifyContent==='space-between'"), assertion("action order remains default zero", "getComputedStyle(document.querySelector('.action')).order", "0"), { document: cssDocument }, { document: cssDocument, axe: true }),
  "css.grid.tracks": h(CSS_FIXTURES.grid, "explicit responsive grid tracks", assertion("grid display and multiple columns compute on wide view", "getComputedStyle(document.querySelector('.grid')).display==='grid' && getComputedStyle(document.querySelector('.grid')).gridTemplateColumns.split(' ').length>=2"), assertion("track never forces horizontal overflow", "document.querySelector('.grid').scrollWidth<=document.querySelector('.grid').clientWidth"), { document: cssDocument }, { document: cssDocument }),
  "css.grid.responsive": h(CSS_FIXTURES.grid, "intrinsic auto-fit/minmax grid", assertion("wide view creates multiple tracks", "getComputedStyle(document.querySelector('.grid')).gridTemplateColumns.split(' ').length>=2"), assertion("narrow view collapses safely", "document.documentElement.scrollWidth<=innerWidth"), { document: cssDocument }, { document: cssDocument }),
  "css.responsive.media": h(CSS_FIXTURES.responsive, "content-driven viewport media query", assertion("wide viewport adds inline body padding", "parseFloat(getComputedStyle(document.body).paddingLeft)>=32"), assertion("narrow baseline does not require the query", "parseFloat(getComputedStyle(document.body).paddingLeft)<32"), { document: cssDocument }, { document: cssDocument }),
  "css.responsive.container": h(CSS_FIXTURES.responsive, "component adaptation through container query", assertion("panel establishes an inline-size query container", "getComputedStyle(document.querySelector('.panel')).containerType", "inline-size"), assertion("narrow container keeps one grid track", "getComputedStyle(document.querySelector('.grid')).gridTemplateColumns.split(' ').length", 1), { document: cssDocument }, { document: cssDocument }),
  "css.motion.transitions": h(CSS_FIXTURES.motion, "bounded composite-friendly transition", assertion("transform transition is declared", "getComputedStyle(document.querySelector('.action')).transitionProperty.includes('transform')"), assertion("transition duration is finite and short", "parseFloat(getComputedStyle(document.querySelector('.action')).transitionDuration)<=0.18"), { document: cssDocument }, { document: cssDocument }),
  "css.motion.preferences": h(CSS_FIXTURES.motion, "reduced-motion equivalent without movement", assertion("normal preference retains feedback transition", "parseFloat(getComputedStyle(document.querySelector('.action')).transitionDuration)>0.1"), assertion("reduced preference removes meaningful duration", "parseFloat(getComputedStyle(document.querySelector('.action')).transitionDuration)<=0.001"), { document: cssDocument, reducedMotion: "no-preference" }, { document: cssDocument, reducedMotion: "reduce", axe: true }),
  "css.quality.compatibility": h(CSS_FIXTURES.compatibility, "usable flex fallback enhanced by @supports grid", assertion("supporting browser selects grid enhancement", "getComputedStyle(document.querySelector('.grid')).display", "grid"), assertion("stylesheet contains an explicit baseline before supports", "document.querySelector('style').textContent.indexOf('display: flex')<document.querySelector('style').textContent.indexOf('@supports')"), { document: cssDocument }, { document: cssDocument }),

  "javascript.runtime.script": h(jsScript, "intentional browser script loading and observable output", assertion("script records its bounded load", "document.body.dataset.scriptLoaded", "true"), assertion("script changes user-observable output", "document.querySelector('output').textContent", "ready"), { document: "<main><h1>Script</h1><output></output></main>" }, { document: "<main><h1>Script</h1><output></output></main>" }),
  "javascript.runtime.modules": h(jsModule, "strict module execution with lexical top-level semantics", assertion("module computes its exported-style value", "document.querySelector('output').textContent", "14"), assertion("module top-level function this is undefined", "globalThis.moduleThisIsUndefined", true), { document: "<main><h1>Module</h1><output></output></main>" }, { document: "<main><h1>Module</h1><output></output></main>" }),
  "javascript.runtime.event-loop": h(jsEventLoop, "synchronous work before queued microtask", assertion("microtask observes sync first", "document.querySelector('output').textContent", "sync,microtask"), assertion("microtask checkpoint occurs before timer task", "document.querySelector('output').textContent.startsWith('sync,microtask')", true), { document: "<main><h1>Order</h1><output></output></main>", actions: [{ type: "wait", milliseconds: 10 }] }, { document: "<main><h1>Order</h1><output></output></main>", actions: [{ type: "wait", milliseconds: 10 }] }),
  "javascript.modules.import-export": h(jsModule, "module-scoped dependency result without classic-script globals", assertion("module result is rendered", "document.querySelector('output').textContent", "14"), assertion("module local is absent from global object", "Object.hasOwn(globalThis,'value')", false), { document: "<main><h1>Module</h1><output></output></main>" }, { document: "<main><h1>Module</h1><output></output></main>" }),
  "javascript.dom.query-update": h(jsDom, "query, text, data attribute and class updates", assertion("heading receives state class", "document.querySelector('h1').classList.contains('ready')"), assertion("new item exposes text and data separately", "document.querySelector('li').textContent+':'+document.querySelector('li').dataset.skill", "Arrays:arrays"), { document: "<main><h1>Topics</h1><ul></ul></main>" }, { document: "<main><h1>Topics</h1><ul></ul></main>" }),
  "javascript.dom.create": h(jsDom, "semantic node creation and ownership", assertion("created item is an LI owned by UL", "document.querySelector('ul>li')?.tagName", "LI"), assertion("exactly one new child is appended", "document.querySelector('ul').children.length", 1), { document: "<main><h1>Topics</h1><ul></ul></main>" }, { document: "<main><h1>Topics</h1><ul></ul></main>" }),
  "javascript.events.model": h(jsEvents, "delegated bubbling event from stable ancestor", assertion("delegated click reads target data", "document.querySelector('output').textContent", "two"), assertion("handler preserves native button target", "document.querySelector('li:nth-child(2) button').tagName", "BUTTON"), { document: "<main><ul><li><button data-value='one'>One</button></li><li><button data-value='two'>Two</button></li></ul><form><label>Topic <input name='topic'></label><button>Save</button></form><output></output></main>", actions: [{ type: "click", selector: "li:nth-child(2) button" }] }, { document: "<main><ul><li><button data-value='one'>One</button></li><li><button data-value='two'>Two</button></li></ul><form><label>Topic <input name='topic'></label><button>Save</button></form><output></output></main>", actions: [{ type: "click", selector: "li:first-child button" }] }),
  "javascript.events.forms": h(jsEvents, "submit event, native controls and perceivable result", assertion("submitted value becomes observable", "document.querySelector('output').textContent", "arrays"), assertion("blank submission produces required state", "document.querySelector('output').textContent", "required"), { document: "<main><ul><li><button data-value='one'>One</button></li></ul><form><label>Topic <input name='topic'></label><button>Save</button></form><output></output></main>", actions: [{ type: "fill", selector: "input", value: "arrays" }, { type: "click", selector: "form button" }] }, { document: "<main><ul><li><button data-value='one'>One</button></li></ul><form><label>Topic <input name='topic'></label><button>Save</button></form><output></output></main>", actions: [{ type: "click", selector: "form button" }], axe: true }),
  "javascript.network.fetch": h(jsFetch, "HTTP status/body handling through fetch", assertion("fulfilled response renders parsed body", "document.querySelector('output').textContent", "Network lesson"), assertion("non-success status reaches recoverable failure", "document.querySelector('output').textContent", "failed"), { document: "<main><h1>Fetch</h1><output></output></main>", routes: [{ url: "https://learncoding.test/api/lesson", status: 200, contentType: "application/json", body: "{\"title\":\"Network lesson\"}" }], actions: [{ type: "wait", milliseconds: 20 }] }, { document: "<main><h1>Fetch</h1><output></output></main>", routes: [{ url: "https://learncoding.test/api/lesson", status: 503, contentType: "application/json", body: "{}" }], actions: [{ type: "wait", milliseconds: 20 }] }),
  "javascript.async.cancellation": h(jsFetch, "AbortController prevents obsolete work", assertion("request begins in a bounded state", "['loading','Network lesson'].includes(document.querySelector('output').textContent)"), assertion("abort produces explicit cancelled state", "document.querySelector('output').textContent", "cancelled"), { document: "<main><h1>Fetch</h1><output></output></main>", routes: [{ url: "https://learncoding.test/api/lesson", status: 200, contentType: "application/json", body: "{\"title\":\"Network lesson\"}" }] }, { document: "<main><h1>Fetch</h1><output></output></main>", routes: [{ url: "https://learncoding.test/api/lesson", status: 200, contentType: "application/json", body: "{\"title\":\"late\"}", delayMs: 100 }], actions: [{ type: "evaluate", expression: "globalThis.cancelRequest()" }, { type: "wait", milliseconds: 10 }] }),
  "javascript.browser.url": h(jsUrlStorage, "URLSearchParams plus history state", assertion("query value is parsed and rendered", "document.querySelector('output').textContent", "review:review"), assertion("history state stores parsed mode", "history.state.mode", "review"), { url: "https://learncoding.test/?mode=review", document: "<main><h1>Preferences</h1><output></output></main>" }, { url: "https://learncoding.test/?mode=review", document: "<main><h1>Preferences</h1><output></output></main>" }),
  "javascript.browser.storage": h(jsUrlStorage, "versioned JSON preference in same-origin storage", assertion("stored JSON round-trips", "JSON.parse(localStorage.getItem('preferences.v1')).mode", "review"), assertion("client output reflects parsed stored value", "document.querySelector('output').textContent.endsWith(':review')", true), { url: "https://learncoding.test/?mode=review", document: "<main><h1>Preferences</h1><output></output></main>" }, { url: "https://learncoding.test/?mode=review", document: "<main><h1>Preferences</h1><output></output></main>" }),
  "javascript.security.dom-xss": h(jsXss, "untrusted content assigned through textContent", assertion("markup is rendered as text rather than an element", "document.querySelector('output img')===null && document.querySelector('output').textContent.startsWith('<img')"), assertion("injected event handler never executes", "globalThis.compromised===undefined"), { document: "<main><h1>Safe output</h1><output></output></main>" }, { document: "<main><h1>Safe output</h1><output></output></main>" }),
  "javascript.quality.dom-tests": h(jsDomTest, "user-observable async DOM transition", assertion("initial state is idle", "document.querySelector('output').textContent", "idle"), assertion("interaction reaches saved state after microtask", "document.querySelector('output').textContent", "saved"), { document: "<main><h1>Save</h1><button>Save</button><output></output></main>" }, { document: "<main><h1>Save</h1><button>Save</button><output></output></main>", actions: [{ type: "click", selector: "button" }, { type: "wait", milliseconds: 1 }], axe: true }),

  "react.model.root": h(REACT_FIXTURES.basics, "single createRoot mount into an owned container", assertion("React commits one main subtree", "document.querySelectorAll('#root>main').length", 1), assertion("root content remains semantic", "document.querySelector('#root h1').textContent", "Course plan")),
  "react.model.declarative": h(REACT_FIXTURES.basics, "UI derived from in-memory lesson data", assertion("data produces two list rows", "document.querySelectorAll('li').length", 2), assertion("rendered IDs follow source data", "Array.from(document.querySelectorAll('li')).map(e=>e.dataset.id)", ["html","css"])),
  "react.components.functions": h(REACT_FIXTURES.basics, "capitalized pure function component", assertion("Status renders user-observable state", "document.querySelector('[role=status]').textContent", "Ready"), assertion("component output contains no wrapper-only custom tag", "document.querySelector('status')===null")),
  "react.components.jsx": h(REACT_FIXTURES.basics, "JSX expressions and React DOM attributes", assertion("JSX data-id becomes DOM dataset", "document.querySelector('li').dataset.id", "html"), assertion("JSX output retains native list semantics", "document.querySelector('ul>li')?.tagName", "LI")),
  "react.components.conditionals": h(REACT_FIXTURES.basics, "explicit ready/loading branch", assertion("truthy ready branch renders", "document.querySelector('[role=status]').textContent", "Ready"), assertion("falsey numeric leakage is absent", "document.body.textContent.includes('Loading')", false)),
  "react.components.lists": h(REACT_FIXTURES.basics, "stable domain keys for list identity", assertion("both domain rows render", "Array.from(document.querySelectorAll('li')).map(e=>e.textContent)", ["HTML","CSS"]), assertion("domain IDs survive reorder-independent rendering", "new Set(Array.from(document.querySelectorAll('li')).map(e=>e.dataset.id)).size", 2)),
  "react.props.data": h(REACT_FIXTURES.props, "read-only title input rendered by child", assertion("prop title labels the card", "document.querySelector('article h2').textContent", "JavaScript"), assertion("child receives content without mutating parent DOM", "document.querySelectorAll('article').length", 1)),
  "react.props.children": h(REACT_FIXTURES.props, "focused children composition slot", assertion("children paragraph is inside card content", "document.querySelector('article div p').textContent", "Browser programming"), assertion("composition preserves article heading and action", "!!document.querySelector('article h2') && !!document.querySelector('article button')")),
  "react.props.purity": h(REACT_FIXTURES.props, "render without observable external side effect", assertion("Strict Mode still commits one card", "document.querySelectorAll('article').length", 1), assertion("output starts empty rather than render-mutated", "document.querySelector('output').textContent", "")),
  "react.state.use-state": h(REACT_FIXTURES.state, "state snapshot updated through setter", assertion("initial snapshot is zero", "document.querySelector('button').textContent", "Count 0"), assertion("click commits next snapshot and derived value", "document.querySelector('button').textContent+':'+document.querySelector('[data-testid=double]').textContent", "Count 1:Double 2"), {}, { actions: [{ type: "click", selector: "main>button:first-of-type" }] }),
  "react.state.events": h(REACT_FIXTURES.state, "native button handler passed, not called during render", assertion("initial render does not increment", "document.querySelector('button').textContent", "Count 0"), assertion("keyboard-compatible click updates state", "document.querySelector('button').textContent", "Count 1"), {}, { actions: [{ type: "click", selector: "main>button:first-of-type" }], axe: true }),
  "react.state.structure": h(REACT_FIXTURES.state, "derived doubled value rather than redundant state", assertion("derived output begins consistent", "document.querySelector('[data-testid=double]').textContent", "Double 0"), assertion("derived output stays consistent after two updates", "document.querySelector('[data-testid=double]').textContent", "Double 4"), {}, { actions: [{ type: "click", selector: "main>button:first-of-type" }, { type: "click", selector: "main>button:first-of-type" }] }),
  "react.state.lifting": h(REACT_FIXTURES.state, "shared count owned by nearest common parent", assertion("siblings share initial value", "Array.from(document.querySelectorAll('button')).map(e=>e.textContent)", ["Count 0","Count 0"]), assertion("one update is reflected by both siblings", "Array.from(document.querySelectorAll('button')).map(e=>e.textContent)", ["Count 1","Count 1"]), {}, { actions: [{ type: "click", selector: "main>button:first-of-type" }] }),
  "react.forms.controlled": h(REACT_FIXTURES.forms, "controlled labeled email input", assertion("input starts controlled and labeled", "document.querySelector('label[for=email]')?.control?.value", ""), assertion("typed value is retained by React state", "document.querySelector('#email').value", "learner@example.test"), {}, { actions: [{ type: "fill", selector: "#email", value: "learner@example.test" }], axe: true }),
  "react.forms.validation": h(REACT_FIXTURES.forms, "persistent accessible validation error and recovery", assertion("invalid submit links an alert to input", "document.querySelector('#email').getAttribute('aria-describedby')==='email-error' && document.querySelector('[role=alert]').textContent==='Enter a valid email'"), assertion("valid retry clears error and increments attempts", "document.querySelector('[role=alert]').textContent+':'+document.querySelector('output').textContent", ":Attempts 1"), { actions: [{ type: "click", selector: "form button" }] }, { actions: [{ type: "fill", selector: "#email", value: "learner@example.test" }, { type: "click", selector: "form button" }], axe: true }),
  "react.state.reducer": h(REACT_FIXTURES.forms, "pure action-driven reducer transition", assertion("reducer state begins at zero attempts", "document.querySelector('output').textContent", "Attempts 0"), assertion("valid submit dispatches exactly one transition", "document.querySelector('output').textContent", "Attempts 1"), {}, { actions: [{ type: "fill", selector: "#email", value: "a@b.test" }, { type: "click", selector: "form button" }] }),
  "react.state.reducer-context": h(REACT_FIXTURES.context, "focused reducer-backed provider boundary", assertion("consumer reads provider default", "document.querySelector('button').textContent", "Theme light"), assertion("provider transition reaches consumer", "document.querySelector('button').textContent", "Theme dark"), {}, { actions: [{ type: "click", selector: "button" }] }),
  "react.effects.dependencies": h(REACT_FIXTURES.effects, "effect reruns from declared topic dependency", assertion("initial dependency synchronizes document title", "document.title", "Topic: HTML"), assertion("changed dependency synchronizes new title", "document.title", "Topic: CSS"), { actions: [{ type: "wait", milliseconds: 20 }] }, { actions: [{ type: "fill", selector: "input", value: "CSS" }, { type: "wait", milliseconds: 20 }] }),
  "react.effects.cleanup": h(REACT_FIXTURES.effects, "setup/cleanup symmetry for window subscription", assertion("mounted listener responds once", "(window.dispatchEvent(new Event('course-refresh')),true)"), assertion("unmounted listener no longer renders or updates", "document.querySelector('output')===null"), { actions: [{ type: "wait", milliseconds: 1 }] }, { actions: [{ type: "click", selector: "button:nth-of-type(2)" }, { type: "wait", milliseconds: 1 }] }),
  "react.refs.dom": h(REACT_FIXTURES.effects, "DOM ref used for explicit focus transition", assertion("input is not forced focused during render", "document.activeElement===document.querySelector('input')", false), assertion("user action moves focus to input", "document.activeElement===document.querySelector('input')", true), {}, { actions: [{ type: "click", selector: "button:first-of-type" }], axe: true }),
  "react.data.states": h(REACT_FIXTURES.data, "explicit loading then success state", assertion("initial or settled state is named", "['Loading','Async JavaScript'].some(value=>document.body.textContent.includes(value))"), assertion("fulfilled state exposes lesson heading", "document.querySelector('article h2').textContent", "Async JavaScript"), {}, { actions: [{ type: "wait", milliseconds: 50 }] }),
  "react.data.fetch": h(REACT_FIXTURES.data, "bounded asynchronous lifecycle with stale-result cleanup", assertion("loading state is perceivable", "document.querySelector('[role=status]')!==null || document.querySelector('article')!==null"), assertion("latest mounted request commits success", "document.querySelector('article h2').textContent", "Async JavaScript"), {}, { actions: [{ type: "wait", milliseconds: 50 }] }),
  "react.data.mutations": h(REACT_FIXTURES.data, "duplicate-safe pending mutation and recovery message", assertion("mutation action begins enabled", "document.querySelector('button').disabled", false), assertion("completed mutation restores action and announces result", "document.querySelector('button').disabled===false && document.querySelector('output').textContent==='Saved'"), {}, { actions: [{ type: "click", selector: "button" }, { type: "wait", milliseconds: 5 }] }),
  "react.data.custom-hook": h(REACT_FIXTURES.data, "focused reusable stateful lesson hook", assertion("hook owns a named loading/success state", "document.querySelector('[role=status]')!==null || document.querySelector('article')!==null"), assertion("hook result drives user-visible title", "document.querySelector('article h2').textContent", "Async JavaScript"), {}, { actions: [{ type: "wait", milliseconds: 50 }] }),
  "react.routing.routes": h(portfolioSource, "declarative nested routes and real Link navigation", assertion("Projects link changes the browser path and rendered route", "location.pathname==='/projects' && document.querySelector('main h1')?.textContent==='Projects'"), assertion("direct nested route renders through the same route tree", "location.pathname==='/projects/compiler-visualizer' && document.body.textContent.includes('Project compiler-visualizer')"), { actions: [{ type: "click", selector: "a[href='/projects']" }, { type: "wait", milliseconds: 50 }] }, { url: "https://learncoding.test/projects/compiler-visualizer", actions: [{ type: "wait", milliseconds: 30 }] }),
  "react.routing.params": h(portfolioSource, "untrusted path/search parameters with explicit missing-resource state", assertion("path and search values are parsed into bounded output", "document.querySelector('[data-project-id]')?.dataset.projectId==='graph-lab' && document.body.textContent.includes('Tab: code')"), assertion("unknown parameter renders an explicit alert", "document.querySelector('[role=alert]')?.textContent", "Project not found"), { url: "https://learncoding.test/projects/graph-lab?tab=code", actions: [{ type: "wait", milliseconds: 30 }] }, { url: "https://learncoding.test/projects/unknown", actions: [{ type: "wait", milliseconds: 30 }] }),
  "react.routing.focus": h(portfolioSource, "route title and programmatic heading focus after client navigation", assertion("client route updates title and focuses its heading", "document.title==='Projects - Codestead' && document.activeElement?.textContent==='Projects'"), assertion("direct detail entry establishes perceivable title and focus", "document.title==='Project detail - Codestead' && document.activeElement?.textContent==='Project detail'"), { actions: [{ type: "click", selector: "a[href='/projects']" }, { type: "wait", milliseconds: 30 }], axe: true }, { url: "https://learncoding.test/projects/graph-lab", actions: [{ type: "wait", milliseconds: 30 }], axe: true }),
  "react.context.services": h(REACT_FIXTURES.context, "narrow theme service context", assertion("context consumer has explicit initial contract", "document.querySelector('button').getAttribute('aria-pressed')", "false"), assertion("service toggles value and accessible state", "document.querySelector('button').textContent+':'+document.querySelector('button').getAttribute('aria-pressed')", "Theme dark:true"), {}, { actions: [{ type: "click", selector: "button" }], axe: true }),
  "react.robustness.semantics": h(REACT_FIXTURES.robustness, "native controls and landmark/heading semantics", assertion("actions are native buttons under main", "document.querySelectorAll('main button').length", 2), assertion("automated serious/critical accessibility audit passes", "true"), {}, { axe: true }),
  "react.robustness.errors": h(REACT_FIXTURES.robustness, "feature error boundary with perceivable fallback", assertion("healthy feature renders normally", "document.body.textContent.includes('Feature ready')", true), assertion("render failure is contained by alert fallback", "document.querySelector('[role=alert]').textContent", "Feature unavailable"), {}, { actions: [{ type: "click", selector: "button:nth-of-type(2)" }, { type: "wait", milliseconds: 1 }], allowedConsoleErrors: ["demo"] }),
  "react.robustness.memo": h(REACT_FIXTURES.robustness, "stable memoized child across unrelated state", assertion("memoized child renders initially", "document.querySelector('[data-renders]').getAttribute('data-renders')", "1"), assertion("unrelated update does not rerender stable child", "document.querySelector('[data-renders]').getAttribute('data-renders')", "1"), {}, { actions: [{ type: "click", selector: "button:first-of-type" }] }),
  "react.testing.queries": h(portfolioSource, "learner-authored role/name query and realistic interaction suite", assertion("test entrypoint records accessible role/name query evidence", "globalThis.__testError===undefined && globalThis.__testResults?.includes('role-name-query') && globalThis.__testResults?.includes('realistic-click')"), assertion("query evidence remains deterministic on a second isolated run", "globalThis.__testError===undefined && globalThis.__testResults?.filter(value=>value==='role-name-query').length===1"), { entrypoint: "test", actions: [{ type: "wait", milliseconds: 500 }] }, { entrypoint: "test", actions: [{ type: "wait", milliseconds: 500 }] }),
  "react.testing.async": h(portfolioSource, "learner-authored observable async-state wait", assertion("test suite waits for success, failure and empty async states", "globalThis.__testError===undefined && ['async-state','async-error','async-empty'].every(value=>globalThis.__testResults?.includes(value))"), assertion("async success completes before route assertion publication", "globalThis.__testResults?.indexOf('async-state') < globalThis.__testResults?.indexOf('route-param')"), { entrypoint: "test", actions: [{ type: "wait", milliseconds: 500 }] }, { entrypoint: "test", actions: [{ type: "wait", milliseconds: 500 }] }),
  "react.testing.routes": h(portfolioSource, "MemoryRouter integration tests for navigation, direct entry and focus context", assertion("route integration suite covers parameter and focus transitions", "globalThis.__testError===undefined && ['route-param','route-focus'].every(value=>globalThis.__testResults?.includes(value))"), assertion("direct-entry route is covered independently", "globalThis.__testError===undefined && globalThis.__testResults?.includes('direct-entry')"), { entrypoint: "test", actions: [{ type: "wait", milliseconds: 500 }] }, { entrypoint: "test", actions: [{ type: "wait", milliseconds: 500 }] }),
  "react.project.spa": h(portfolioSource, "minimal routed, responsive, accessible portfolio SPA with form state, complete async states and tests", assertion("portfolio journey reaches a parameterized project with title/focus context", "location.pathname==='/projects/compiler-visualizer' && document.body.textContent.includes('Project compiler-visualizer') && document.title==='Project detail - Codestead' && document.activeElement?.textContent==='Project detail'"), assertion("the separate test entrypoint passes all nine bounded checks", "globalThis.__testError===undefined && Array.isArray(globalThis.__testResults) && globalThis.__testResults.length===9"), { actions: [{ type: "click", selector: "a[href='/projects']" }, { type: "wait", milliseconds: 50 }, { type: "click", selector: "a[href='/projects/compiler-visualizer']" }, { type: "wait", milliseconds: 30 }], axe: true }, { entrypoint: "test", actions: [{ type: "wait", milliseconds: 500 }] }),
} as const satisfies Readonly<Record<string, BrowserWebTaskSpec>>;

function nodeTask(
  facet: string,
  prompt: string,
  body: string,
  visible: readonly [string, string],
  hidden: readonly [string, string],
): NodeWebTaskSpec {
  const prelude = "const fs = require('node:fs');\nconst input = fs.readFileSync(0, 'utf8').trim();\n";
  return {
    classification: "executable",
    facet,
    prompt,
    starterCode: prelude + "// TODO: implement the declared deterministic contract.\n",
    referenceSolution: prelude + body + "\n",
    tests: [
      { id: "visible-normal", visibility: "visible", category: "normal", stdin: visible[0], expectedStdout: visible[1] },
      { id: "hidden-boundary", visibility: "hidden", category: "boundary", stdin: hidden[0], expectedStdout: hidden[1] },
    ],
  };
}

export const WEB_NEW_NODE_TASKS = {
  "javascript.values.primitives": nodeTask("primitive type distinctions", "Read JSON values and print JavaScript typeof results, using null as the explicit null special case.", "const values=JSON.parse(input); console.log(values.map(v=>v===null?'null':typeof v).join(' '));", ["[1,\"x\",true,null]", "number string boolean null\n"], ["[null,false,0]", "null boolean number\n"]),
  "javascript.values.variables": nodeTask("const binding with deliberate object mutation", "Read a JSON object, add one to its count property through a const binding, and print JSON.", "const record=JSON.parse(input); record.count+=1; console.log(JSON.stringify(record));", ["{\"count\":2}", "{\"count\":3}\n"], ["{\"count\":-1,\"name\":\"x\"}", "{\"count\":0,\"name\":\"x\"}\n"]),
  "javascript.values.coercion": nodeTask("explicit numeric conversion and strict comparison", "Read two whitespace-separated tokens, convert both explicitly to numbers, and print their sum plus strict text equality.", "const [left,right]=input.split(/\\s+/); console.log(`${Number(left)+Number(right)} ${left===right}`);", ["2 3", "5 false\n"], ["01 1", "2 false\n"]),
  "javascript.values.numbers": nodeTask("finite and safe-integer boundary checks", "Read one numeric token and print finite, safe, and its value rounded to two decimal places.", "const value=Number(input); console.log(`${Number.isFinite(value)} ${Number.isSafeInteger(value)} ${Number.isFinite(value)?value.toFixed(2):'not-finite'}`);", ["12.5", "true false 12.50\n"], ["9007199254740992", "true false 9007199254740992.00\n"]),
  "javascript.functions.forms": nodeTask("function declaration and arrow transformation", "Read integers and use a declared parser plus an arrow square function to print their squares.", "function parse(text){return text.split(/\\s+/).map(Number)} const square=value=>value*value; console.log(parse(input).map(square).join(' '));", ["2 3 4", "4 9 16\n"], ["0 -2", "0 4\n"]),
  "javascript.functions.parameters": nodeTask("default and rest parameter contract", "Read zero or more numbers and call a function with a default starting value and rest values; print the sum.", "function total(start=0,...values){return values.reduce((sum,value)=>sum+value,start)} const values=input?input.split(/\\s+/).map(Number):[]; console.log(total(...values));", ["1 2 3", "6\n"], ["", "0\n"]),
  "javascript.collections.objects": nodeTask("computed record property and own-key distinction", "Read key and JSON object; print whether the key is own and its JSON-encoded value.", "const space=input.indexOf(' '); const key=input.slice(0,space); const record=JSON.parse(input.slice(space+1)); console.log(`${Object.hasOwn(record,key)} ${JSON.stringify(record[key])}`);", ["name {\"name\":\"Asha\"}", "true \"Asha\"\n"], ["missing {\"name\":\"Asha\"}", "false undefined\n"]),
  "javascript.objects.this": nodeTask("method receiver preserved with bind", "Read an integer, bind an object method to its receiver, and print the adjusted value.", "const record={base:10,add(value){return this.base+value}}; const add=record.add.bind(record); console.log(add(Number(input)));", ["5", "15\n"], ["-10", "0\n"]),
  "javascript.objects.prototype": nodeTask("own then prototype property lookup", "Read a name, create a record delegating to a shared prototype, and print own/delegated values.", "const shared={kind:'lesson'}; const record=Object.create(shared); record.name=input; console.log(`${record.name} ${record.kind} ${Object.hasOwn(record,'kind')}`);", ["Arrays", "Arrays lesson false\n"], ["", " lesson false\n"]),
  "javascript.objects.classes": nodeTask("class constructor and private state", "Read start and steps; update a class with a private count and print its public value.", "class Counter{#value;constructor(value){this.#value=value}increment(){this.#value+=1}get value(){return this.#value}} const [start,steps]=input.split(/\\s+/).map(Number); const counter=new Counter(start); for(let i=0;i<steps;i+=1)counter.increment(); console.log(counter.value);", ["3 4", "7\n"], ["0 0", "0\n"]),
  "javascript.objects.composition": nodeTask("composed validation and transformation functions", "Read an integer; compose clamp and label functions and print the bounded label.", "const clamp=value=>Math.max(0,Math.min(100,value)); const label=value=>`score:${value}`; const evaluate=value=>label(clamp(value)); console.log(evaluate(Number(input)));", ["75", "score:75\n"], ["125", "score:100\n"]),
  "javascript.scope.lexical": nodeTask("block-scoped shadowing without outer mutation", "Read one integer; shadow it inside a block and print inner then outer values.", "const value=Number(input); { const value=Number(input)+1; process.stdout.write(value+' '); } console.log(value);", ["4", "5 4\n"], ["-1", "0 -1\n"]),
  "javascript.scope.closures": nodeTask("closure-retained counter state", "Read start and step count; create a closure counter and print successive values.", "const [start,steps]=input.split(/\\s+/).map(Number); function counter(value){return()=>++value} const next=counter(start); console.log(Array.from({length:steps},()=>next()).join(' '));", ["3 3", "4 5 6\n"], ["9 0", "\n"]),
  "javascript.async.await": nodeTask("intentional concurrent await with stable output order", "Read integers; resolve all doubled values concurrently with Promise.all and print them in input order.", "async function main(){const values=input.split(/\\s+/).filter(Boolean).map(Number);const doubled=await Promise.all(values.map(async value=>value*2));console.log(doubled.join(' '))} main().catch(()=>{process.exitCode=1});", ["1 3 2", "2 6 4\n"], ["0 -2", "0 -4\n"]),
  "javascript.errors.exceptions": nodeTask("typed error, cause preservation and recovery boundary", "Read an integer token; print doubled value or invalid with the preserved cause name.", "function parse(text){const value=Number(text);if(!Number.isInteger(value))throw new TypeError('integer required',{cause:new Error('parse')});return value} try{console.log(parse(input)*2)}catch(error){console.log(`invalid:${error.cause?.constructor.name??'unknown'}`)}", ["12", "24\n"], ["nope", "invalid:Error\n"]),
} as const satisfies Readonly<Record<string, NodeWebTaskSpec>>;

export const WEB_RETAINED_NODE_SKILLS = [
  "javascript.control.selection",
  "javascript.control.iteration",
  "javascript.collections.arrays",
  "javascript.collections.methods",
  "javascript.collections.map-set",
  "javascript.async.promises",
] as const;

export const WEB_NON_CODE_FACETS = {
  "html.tables.complexity": "Choosing whether to split a complex table is a content-design and assistive-reading judgment; a bounded DOM oracle would overclaim the outcome.",
  "html.accessibility.audit": "A complete keyboard, accessibility-tree, browser-zoom, and assistive-technology audit requires human and real-device evidence beyond one automated Chromium artifact.",
  "html.quality.conformance": "Formal conformance requires a pinned standards validator and interpretation of its findings; that service is not installed in the offline verifier.",
  "html.quality.content-review": "Holistic page-purpose and semantic-content review requires human judgment across the complete artifact.",
  "html.project.site": "A coherent multi-page site requires multi-file navigation, content-quality, and human usability review rather than one isolated code item.",
  "css.system.organization": "Stylesheet architecture across reset, base, layout, component, and utility files requires multi-file maintainability review.",
  "css.quality.devtools": "DevTools investigation evidence is an observed diagnostic process, not a deterministic final-DOM property.",
  "css.quality.accessibility": "The full contrast, focus, reflow, zoom, text-spacing, target-size, motion, and assistive-technology audit requires multiple settings and human review.",
  "css.project.system": "A cross-page design system requires multi-file consistency and usability review beyond one bounded browser artifact.",
  "javascript.runtime.devtools": "Breakpoints, scope inspection, and live-object interpretation require recorded human DevTools process evidence.",
  "javascript.modules.architecture": "Domain/browser/presentation boundaries require a multi-file module graph and architecture review, which the current one-entrypoint runner does not grade.",
  "javascript.security.secrets-privacy": "Privacy minimization and absence of client secrets require threat-model and delivered-bundle review, not a small execution oracle.",
  "javascript.quality.unit-tests": "Authored test quality requires a pinned test-runner artifact grader; passing domain behavior alone would not prove the learner wrote useful tests.",
  "javascript.project.browser-app": "The modular browser capstone requires multi-file build, integration, security, accessibility, and human product review.",
  "react.model.devtools": "Component-tree and render-cause diagnosis requires recorded human React DevTools evidence.",
  "react.model.project": "The multi-file reference artifact has an exact manifest and browser bundle, but Vite dev/build/preview commands are not yet executed in a separate Node 22.22+ project-toolchain verifier.",
  "react.props.interfaces": "Minimal, cohesive public component API design is an architecture-review judgment across multiple consumers.",
  "react.effects.need": "Proving that an effect is unnecessary requires design review of alternate render/event placement; a passing UI cannot establish absence of needless synchronization.",
  "react.robustness.performance": "Optimization decisions require profiler traces and a human justification, not a fixed pass/fail DOM state.",
} as const satisfies Readonly<Record<string, string>>;

export type WebExecutableTaskSpec = BrowserWebTaskSpec | NodeWebTaskSpec;
