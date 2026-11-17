export const PAGE_PAD_X = 20;
export const GRID_COL_GAP = 8;
export const GRID_ROW_GAP = 12;

export const cellHeightFor = (cellPx: number): number =>
  Math.floor((2 * cellPx + GRID_COL_GAP - GRID_ROW_GAP) / 2);
