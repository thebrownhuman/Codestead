import type { ContentGraph } from "./graph";
import type { ContentSnapshot, TrackAccessKind } from "./types";

export interface CatalogTrackViewState {
  readonly id: string;
  readonly title: string;
  readonly release: string;
  readonly scopeBrief: string;
  readonly prerequisites: readonly string[];
  readonly visible: boolean;
  readonly access: TrackAccessKind;
  readonly canEnroll: boolean;
  readonly href: string | null;
  readonly reason: string;
}

export function buildRoadmapCatalogViewStates(
  snapshot: ContentSnapshot,
  graph: ContentGraph,
  completedTrackIds: Iterable<string>,
): readonly CatalogTrackViewState[] {
  const trackById = new Map(snapshot.catalog.tracks.map((track) => [track.id, track]));
  return snapshot.roadmapTracks.map((manifest) => {
    const track = trackById.get(manifest.id);
    if (!track) throw new RangeError(`Roadmap manifest '${manifest.id}' has no catalog track.`);
    const state = graph.getTrackAccessState(track.id, completedTrackIds);
    return {
      id: track.id,
      title: track.title,
      release: track.release,
      scopeBrief: manifest.scope_brief,
      prerequisites: [...track.prerequisites],
      visible: state.visible,
      access: state.access,
      canEnroll: state.canEnroll,
      href: state.canEnroll ? `/courses/${track.id}` : null,
      reason: state.reason,
    };
  }).filter((state) => state.visible);
}
