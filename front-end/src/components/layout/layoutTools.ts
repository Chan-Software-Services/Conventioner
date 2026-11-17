/**
 * The layout editor's tools (T422): their names, as the toolbar and the tool's card say them, and
 * their keys, each pressed alone anywhere on the page but a field.
 */

export type Tool = 'select' | 'add' | 'row' | 'fill' | 'zone';

/** The tools that add tables, each with a card of its options in the panel. */
export type AddingTool = 'add' | 'row' | 'fill';

export const ADDING_TOOLS: readonly Tool[] = ['add', 'row', 'fill'];

export const isAdding = (tool: Tool): tool is AddingTool => ADDING_TOOLS.includes(tool);

export const TOOL_NAMES: Record<Tool, string> = {
  select: 'Select',
  add: 'Add table',
  row: 'Row of tables',
  fill: 'Fill an area',
  zone: 'No-table zone',
};

/** Each tool's key. R is a turn, so Row of tables is W; F swaps a row's side, so Fill an area is
 *  A. */
export const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  t: 'add',
  w: 'row',
  a: 'fill',
  z: 'zone',
};
