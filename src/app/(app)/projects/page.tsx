import { ProjectsView } from "@/components/product/projects-view";
import { FileLibrary } from "@/components/product/file-library";
import { ModuleProjectStudio } from "@/components/projects/module-project-studio";

export default function ProjectsPage() {
  return (
    <div style={{ display: "grid", gap: 24, paddingBottom: 50 }}>
      <ModuleProjectStudio />
      <ProjectsView />
      <FileLibrary />
    </div>
  );
}
