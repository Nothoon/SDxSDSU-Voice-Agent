import type { CardCoverage, CoverageUpdate, IdeaCard, TranscriptSegment } from "../../shared/types.js";

export type CoverageRequest = {
  outline: IdeaCard[];
  // Finalized speaker segments only, oldest first.
  segments: TranscriptSegment[];
  current: Record<string, CardCoverage>;
  transcriptRevision: number;
};

export interface CoverageAdapter {
  readonly name: string;
  readonly simulated: boolean; // true for mock adapters; surfaced so mocks are never presented as live
  evaluate(request: CoverageRequest, signal?: AbortSignal): Promise<CoverageUpdate[]>;
}
