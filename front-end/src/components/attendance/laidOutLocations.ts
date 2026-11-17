/**
 * The locations Attendance's map can draw (T466): one rule, which the map and the page's location
 * select both read, so the select never offers a hall the map cannot draw. Pure: no store, no API.
 */
import type { FloorplanObject, SectionObject, SetupObject } from '@/assets/types/datatypes';

/** A location laid out: its layout and the plan's sections of it. */
export interface LaidOutLocation {
  id: string;
  name: string;
  layout: FloorplanObject;
  sections: SectionObject[];
}

/**
 * The locations laid out, in the plan's order, as the public map's server chooses them
 * (`mapped_locations`): a location with an id, a layout with a scale above 0, and a table numbered
 * in one of the location's own sections.
 */
export function laidOutLocations(
  plan: Pick<SetupObject, 'locations' | 'sections' | 'floorplans'> | null | undefined,
): LaidOutLocation[] {
  return (plan?.locations ?? []).flatMap((location) => {
    const layout = plan?.floorplans?.find((each) => each.locationId === location.id);
    if (!location.id || !layout?.scalePxPerUnit || layout.scalePxPerUnit <= 0) return [];
    const sections = (plan?.sections ?? []).filter(
      (section) => section.id && section.location?.id === location.id,
    );
    const ids = new Set(sections.map((section) => section.id));
    const numbered = layout.tables.some(
      (table) => table.sectionId && ids.has(table.sectionId) && table.number !== null,
    );
    return numbered ? [{ id: location.id, name: location.name, layout, sections }] : [];
  });
}

/** The open location: the one asked for when it is laid out, else the first laid out, else ''. */
export function openLocationId(laidOut: readonly LaidOutLocation[], asked: string): string {
  return laidOut.find((each) => each.id === asked)?.id ?? laidOut[0]?.id ?? '';
}
