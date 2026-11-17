/**
 * The public map's answer the page's and its parts' unit tests read (T422, T465): two halls, Upper
 * Hall's Gold row 2 shared as its left and right halves, one vendor with no public name, four named
 * vendors today and one tomorrow.
 */
import type { PublicMapAnswer } from '@/components/daymap/dayMap';

export const TODAY = '2099-06-05';
export const TOMORROW = '2099-06-06';

const table = (id: string, sectionId: string, number: number, xMm: number) => ({
  id,
  sectionId,
  number,
  tableTypeId: 'type-6ft',
  xMm,
  yMm: 3000,
  rotation: 0,
});

/** Two halls; Gold row 2 shared as its left and right halves; one vendor with no public name. */
export const ANSWER: PublicMapAnswer = {
  marketName: 'Harbour Night Market',
  dates: [TODAY, TOMORROW],
  tableTypes: [{ id: 'type-6ft', name: 'Standard 6 ft', widthMm: 1830, depthMm: 760 }],
  locations: [
    {
      id: 'loc-upper',
      name: 'Upper Hall',
      sections: [{ id: 'sec-gold', name: 'Gold row' }],
      layout: {
        id: 'fp-upper',
        locationId: 'loc-upper',
        imageWidth: 800,
        imageHeight: 600,
        scalePxPerUnit: 800 / 30_000,
        hasImage: true,
        tables: [
          table('g1', 'sec-gold', 1, 5000),
          table('g2', 'sec-gold', 2, 8000),
          table('g3', 'sec-gold', 3, 11_000),
          table('g4', 'sec-gold', 4, 14_000),
        ],
        zones: [],
        sectionStyles: [],
      },
    },
    {
      id: 'loc-lower',
      name: 'Lower Hall',
      sections: [{ id: 'sec-silver', name: 'Silver aisle' }],
      layout: {
        id: 'fp-lower',
        locationId: 'loc-lower',
        imageWidth: 800,
        imageHeight: 400,
        scalePxPerUnit: 800 / 20_000,
        hasImage: false,
        tables: [table('s1', 'sec-silver', 1, 4000)],
        zones: [],
        sectionStyles: [],
      },
    },
  ],
  seats: [
    {
      date: TODAY,
      tableId: 'g1',
      half: 'whole',
      name: 'Kiln & Co',
      website: 'https://www.kiln-and-co.example/shop',
      instagram: 'example_kiln',
    },
    {
      date: TODAY,
      tableId: 'g2',
      half: 'right',
      name: 'Bee Candles',
      website: null,
      instagram: null,
    },
    {
      date: TODAY,
      tableId: 'g2',
      half: 'left',
      name: 'Acme Ceramics',
      website: null,
      instagram: 'example_acme',
    },
    { date: TODAY, tableId: 'g3', half: 'whole', name: null, website: null, instagram: null },
    {
      date: TODAY,
      tableId: 's1',
      half: 'whole',
      name: 'Cog Prints',
      website: null,
      instagram: null,
    },
    {
      date: TOMORROW,
      tableId: 'g4',
      half: 'whole',
      name: 'Dune Glass',
      website: null,
      instagram: null,
    },
  ],
};
