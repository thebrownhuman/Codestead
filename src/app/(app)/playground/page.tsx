import { Code2, Gauge, ShieldCheck, TimerReset } from "lucide-react";

import { CodeLab } from "@/components/lesson/lesson-workspace";
import pageStyles from "@/components/product/product-pages.module.css";

export default function PlaygroundPage() {
  return <div className={pageStyles.page}><header className={pageStyles.pageHead}><div><span className={pageStyles.eyebrow}>Isolated practice</span><h1>Code lab.</h1><p>Compile and run small experiments on the two-slot NUC runner. This is practice mode, so compiler feedback can be explained by Codestead after the run.</p></div><span className="pill"><ShieldCheck size={14} /> No network · strict limits</span></header><section className={pageStyles.stats}><article className={`${pageStyles.stat} card`}><span><Code2 size={18} /></span><div><strong>5</strong><small>runner languages</small></div></article><article className={`${pageStyles.stat} card`}><span><Gauge size={18} /></span><div><strong>2</strong><small>concurrent jobs</small></div></article><article className={`${pageStyles.stat} card`}><span><TimerReset size={18} /></span><div><strong>5 sec</strong><small>quick-run wall limit</small></div></article><article className={`${pageStyles.stat} card`}><span><ShieldCheck size={18} /></span><div><strong>0</strong><small>host code execution</small></div></article></section><CodeLab allowLanguageSelection courseId="python" skillId="free-playground" /></div>;
}
