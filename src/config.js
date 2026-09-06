// Legacy Heights — configuration and static data (house types from drawing 25:04/A-01A, Richard Gill Associates)

export const SQFT_PER_M2 = 10.7639;

// House types as tabulated on the Parcel A Extract Plan (gross floor / roof areas per house, sq ft)
export const TYPES = {
  1: { key: 'type1', beds: 2, baths: 2, gfaSqft: 725, roofSqft: 853, units: 1, hex: '#7bd944', label: { en: 'Type 1 House', pt: 'Casa Tipo 1' } },
  2: { key: 'type2', beds: 3, baths: 1, gfaSqft: 839, roofSqft: 970, units: 1, hex: '#d58cff', label: { en: 'Type 2 House', pt: 'Casa Tipo 2' } },
  3: { key: 'type3', beds: 3, baths: 2, gfaSqft: 874, roofSqft: 975, units: 1, hex: '#3e9bff', label: { en: 'Type 3 House', pt: 'Casa Tipo 3' } },
  4: { key: 'type4', beds: 2, baths: 1, gfaSqft: 700, roofSqft: 799, units: 2, hex: '#f0b429', label: { en: 'Type 4 Duplex', pt: 'Duplex Tipo 4' } },
};

// Colour pattern used in the PDF ("padrao_pdf" custom property in Blender) -> house type
export const PDF_TYPE = { azul: 3, verde: 1, lilas: 2, ouro: 4 };

// Blender model index -> building kind (models 1-3 share the single-house body, 4-6 the duplex body)
export const MODEL_KIND = { 1: 'single', 2: 'single', 3: 'single', 4: 'duplex', 5: 'duplex', 6: 'duplex' };

// Facade colour names (Blender materials) -> display names
export const COLOR_LABEL = {
  'Oak Tone': 'Oak Tone',
  'Caramel cloud': 'Caramel Cloud',
  'isle dreamns': 'Isle Dreams',
  'in the blue': 'In the Blue',
  'Marzipan': 'Marzipan',
  'Pinkathon': 'Pinkathon',
};

// Reference renders (assets/img/house_N.jpg). Each render shows one body kind in one facade colour.
export const IMAGES = {
  single: { 'Caramel cloud': 1, 'Oak Tone': 3, 'Marzipan': 4 },
  duplex: { 'isle dreamns': 2, 'in the blue': 5, 'Pinkathon': 6 },
};
export const IMAGE_COLOR = { 1: 'Caramel cloud', 2: 'isle dreamns', 3: 'Oak Tone', 4: 'Marzipan', 5: 'in the blue', 6: 'Pinkathon' };
export const IMAGE_FALLBACK = { single: 3, duplex: 5 };

export function imageFor(kind, color) {
  const exact = IMAGES[kind]?.[color];
  return { index: exact ?? IMAGE_FALLBACK[kind], exact: exact !== undefined };
}

export const I18N = {
  en: {
    subtitle: 'Lowthers Plantation · Christ Church · Barbados',
    loading: 'Loading the subdivision…',
    houses: 'houses',
    lots: 'lots',
    resetView: 'Overview',
    topView: 'Top view',
    colorByType: 'Colour by type',
    ao: 'AO',
    legend: 'House types',
    search: 'Search house or lot…',
    noResults: 'No match',
    hoverHint: 'Hover a house for a quick summary · click to open details',
    controls: 'Drag to orbit · right-drag / two fingers to pan · scroll to zoom',
    lot: 'Lot',
    house: 'House',
    type: 'Type',
    beds: 'bed',
    baths: 'bath',
    perUnit: 'per unit',
    units: 'units',
    gfa: 'Gross floor area',
    roof: 'Gross roof area',
    lotArea: 'Lot area',
    facade: 'Facade colour',
    model: '3D model',
    openSpace: 'Open space',
    freeLot: 'Lot without a house in the current layout',
    imgNote: 'Reference render shown in',
    imgExact: 'Reference render of this house',
    flyTo: 'Fly to house',
    close: 'Close',
    prev: 'Previous',
    next: 'Next',
    sqft: 'sq ft',
    sqm: 'sq m',
    all: 'All',
    onlyType: 'Only this type',
    showAll: 'Show all types',
    source: 'Areas per drawings 25:04/02D and 25:04/A-01A (Richard Gill Associates Ltd.). Lot areas measured on the 3D model.',
  },
  pt: {
    subtitle: 'Lowthers Plantation · Christ Church · Barbados',
    loading: 'Carregando o loteamento…',
    houses: 'casas',
    lots: 'lotes',
    resetView: 'Visão geral',
    topView: 'Vista de topo',
    colorByType: 'Cor por tipo',
    ao: 'AO',
    legend: 'Tipos de casa',
    search: 'Buscar casa ou lote…',
    noResults: 'Nada encontrado',
    hoverHint: 'Passe o mouse sobre uma casa para o resumo · clique para abrir os detalhes',
    controls: 'Arraste para orbitar · botão direito / dois dedos para mover · scroll para zoom',
    lot: 'Lote',
    house: 'Casa',
    type: 'Tipo',
    beds: 'quarto(s)',
    baths: 'banho(s)',
    perUnit: 'por unidade',
    units: 'unidades',
    gfa: 'Área construída bruta',
    roof: 'Área bruta de telhado',
    lotArea: 'Área do lote',
    facade: 'Cor da fachada',
    model: 'Modelo 3D',
    openSpace: 'Área verde',
    freeLot: 'Lote sem casa no layout atual',
    imgNote: 'Render de referência na cor',
    imgExact: 'Render de referência desta casa',
    flyTo: 'Ir até a casa',
    close: 'Fechar',
    prev: 'Anterior',
    next: 'Próxima',
    sqft: 'sq ft',
    sqm: 'm²',
    all: 'Todos',
    onlyType: 'Somente este tipo',
    showAll: 'Mostrar todos os tipos',
    source: 'Áreas conforme desenhos 25:04/02D e 25:04/A-01A (Richard Gill Associates Ltd.). Áreas de lote medidas no modelo 3D.',
  },
};
