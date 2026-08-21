// Liam's Melbourne territory split (2026-08-22 directive) — Liam covers
// north + west Melbourne, Justine covers east + south-east + bayside +
// Port Phillip. Every suburb below comes verbatim from that directive,
// organised by council/LGA there but flattened here into one lookup: a
// handful of suburb names are genuinely shared by two councils (e.g.
// Fairfield appears under both Yarra and Darebin, Windsor under both Port
// Phillip and Stonnington), but in every one of those cases both councils
// land with the *same* person, so a flat map is safe — no suburb name in
// this file resolves to different people depending on which council it's
// read from.
//
// Regional/outer-Victoria suburbs outside this metro split (e.g. Bacchus
// Marsh, Corio, Romsey — confirmed present on real centre records) aren't
// covered by Liam's directive at all, so they keep the pre-existing
// default (Justine, VIC's sole partner before this split) rather than
// being left unassigned.
const LIAM = 'Liam Baxter (VIC)';
const JUSTINE = 'Justine Hardware (VIC)';

const LIAM_SUBURBS = [
  // Yarra
  'Abbotsford', 'Alphington', 'Burnley', 'Carlton North', 'Clifton Hill', 'Collingwood',
  'Cremorne', 'Fairfield', 'Fitzroy', 'Fitzroy North', 'Princes Hill', 'Richmond',
  // Merri-bek
  'Brunswick', 'Brunswick East', 'Brunswick West', 'Coburg', 'Coburg North', 'Fawkner',
  'Glenroy', 'Gowanbrae', 'Hadfield', 'Oak Park', 'Pascoe Vale', 'Pascoe Vale South',
  // Darebin
  'Bundoora', 'Kingsbury', 'Macleod', 'Northcote', 'Preston', 'Reservoir', 'Thornbury',
  // Banyule
  'Bellfield', 'Briar Hill', 'Eaglemont', 'Eltham North', 'Greensborough', 'Heidelberg',
  'Heidelberg Heights', 'Heidelberg West', 'Ivanhoe', 'Ivanhoe East', 'Lower Plenty',
  'Montmorency', 'Rosanna', 'St Helena', 'Viewbank', 'Watsonia', 'Watsonia North', 'Yallambie',
  // Nillumbik
  'Arthurs Creek', 'Bend of Islands', 'Christmas Hills', 'Cottles Bridge', 'Diamond Creek',
  'Eltham', 'Hurstbridge', 'Kangaroo Ground', 'Plenty', 'Panton Hill', 'Research',
  'Smiths Gully', 'St Andrews', 'Strathewen', 'Wattle Glen', 'Watsons Creek', 'Yarrambat',
  // Whittlesea
  'Beveridge', 'Doreen', 'Donnybrook', 'Eden Park', 'Epping', 'Humevale', 'Kinglake West',
  'Lalor', 'Mernda', 'Mill Park', 'South Morang', 'Thomastown', 'Whittlesea', 'Wollert', 'Woodstock',
  // Hume
  'Attwood', 'Broadmeadows', 'Bulla', 'Campbellfield', 'Clarkefield', 'Coolaroo', 'Craigieburn',
  'Dallas', 'Diggers Rest', 'Gladstone Park', 'Greenvale', 'Jacana', 'Kalkallo', 'Keilor',
  'Meadow Heights', 'Melbourne Airport', 'Mickleham', 'Oaklands Junction', 'Roxburgh Park',
  'Somerton', 'Sunbury', 'Tullamarine', 'Westmeadows', 'Wildwood', 'Yuroke',
  // Moonee Valley
  'Aberfeldie', 'Airport West', 'Ascot Vale', 'Avondale Heights', 'Essendon', 'Essendon Fields',
  'Essendon North', 'Essendon West', 'Flemington', 'Keilor East', 'Moonee Ponds', 'Niddrie',
  'Strathmore', 'Strathmore Heights', 'Travancore',
  // Maribyrnong
  'Braybrook', 'Footscray', 'Kingsville', 'Maidstone', 'Maribyrnong', 'Seddon', 'Tottenham',
  'West Footscray', 'Yarraville',
  // Brimbank
  'Albion', 'Albanvale', 'Ardeer', 'Brooklyn', 'Cairnlea', 'Calder Park', 'Deer Park', 'Delahey',
  'Derrimut', 'Kealba', 'Keilor Downs', 'Keilor Lodge', 'Keilor North', 'Kings Park', 'St Albans',
  'Sunshine', 'Sunshine North', 'Sunshine West', 'Sydenham', 'Taylors Lakes',
  // Hobsons Bay
  'Altona', 'Altona Meadows', 'Altona North', 'Laverton', 'Newport', 'Seaholme', 'Seabrook',
  'Spotswood', 'South Kingsville', 'Williamstown', 'Williamstown North',
  // Wyndham
  'Cocoroc', 'Hoppers Crossing', 'Laverton North', 'Little River', 'Mambourin', 'Manor Lakes',
  'Mount Cottrell', 'Point Cook', 'Quandong', 'Tarneit', 'Truganina', 'Werribee', 'Werribee South',
  'Williams Landing', 'Wyndham Vale',
  // Melton
  'Aintree', 'Bonnie Brook', 'Brookfield', 'Burnside', 'Burnside Heights', 'Caroline Springs',
  'Cobblebank', 'Deanside', 'Exford', 'Eynesbury', 'Fieldstone', 'Fraser Rise', 'Grangefields',
  'Harkness', 'Hillside', 'Kurunjang', 'Melton', 'Melton South', 'Melton West', 'Plumpton',
  'Ravenhall', 'Rockbank', 'Strathtulloh', 'Taylors Hill', 'Thornhill Park', 'Toolern Vale',
  'Weir Views',
  // Melbourne / inner-city
  'Carlton', 'Docklands', 'East Melbourne', 'Kensington', 'Melbourne CBD', 'Melbourne',
  'North Melbourne', 'Parkville', 'West Melbourne',
  // Not in Liam's literal list, but confirmed against real lead data as
  // immediately part of/adjacent to suburbs he already explicitly owns
  // (Keilor Park sits right in the Keilor cluster already all his; Preston
  // West is a local name for part of Preston, already his) — added rather
  // than left to fall through to the Justine default.
  'Keilor Park', 'Preston West'
];

const JUSTINE_SUBURBS = [
  // Port Phillip
  'Albert Park', 'Balaclava', 'Elwood', 'Garden City', 'Middle Park', 'Port Melbourne',
  'Ripponlea', 'South Melbourne', 'Southbank', 'St Kilda', 'St Kilda East', 'St Kilda West', 'Windsor',
  // Stonnington
  'Armadale', 'Glen Iris', 'Kooyong', 'Malvern', 'Malvern East', 'Prahran', 'South Yarra', 'Toorak',
  // Bayside
  'Beaumaris', 'Black Rock', 'Brighton', 'Brighton East', 'Cheltenham', 'Hampton', 'Hampton East',
  'Highett', 'Sandringham',
  // Glen Eira
  'Bentleigh', 'Bentleigh East', 'Carnegie', 'Caulfield', 'Caulfield East', 'Caulfield North',
  'Caulfield South', 'Elsternwick', 'Gardenvale', 'Glen Huntly', 'McKinnon', 'Murrumbeena', 'Ormond',
  // Boroondara
  'Ashburton', 'Balwyn', 'Balwyn North', 'Camberwell', 'Canterbury', 'Deepdene', 'Hawthorn',
  'Hawthorn East', 'Kew', 'Kew East', 'Mont Albert', 'Surrey Hills',
  // Manningham
  'Bulleen', 'Doncaster', 'Doncaster East', 'Donvale', 'Park Orchards', 'Templestowe',
  'Templestowe Lower', 'Warrandyte', 'Warrandyte South', 'Wonga Park',
  // Whitehorse
  'Blackburn', 'Blackburn North', 'Blackburn South', 'Box Hill', 'Box Hill North', 'Box Hill South',
  'Burwood', 'Burwood East', 'Forest Hill', 'Mitcham', 'Mont Albert North', 'Nunawading', 'Vermont',
  'Vermont South',
  // Maroondah
  'Bayswater North', 'Croydon', 'Croydon Hills', 'Croydon North', 'Croydon South', 'Heathmont',
  'Kilsyth South', 'Ringwood', 'Ringwood East', 'Ringwood North', 'Warranwood',
  // Knox
  'Bayswater', 'Boronia', 'Ferntree Gully', 'Knoxfield', 'Lysterfield', 'Rowville', 'Scoresby',
  'The Basin', 'Upper Ferntree Gully', 'Wantirna', 'Wantirna South',
  // Monash
  'Ashwood', 'Chadstone', 'Clayton', 'Glen Waverley', 'Hughesdale', 'Huntingdale', 'Mount Waverley',
  'Mulgrave', 'Notting Hill', 'Oakleigh', 'Oakleigh East', 'Oakleigh South', 'Wheelers Hill',
  // Kingston
  'Aspendale', 'Aspendale Gardens', 'Bonbeach', 'Braeside', 'Carrum', 'Chelsea', 'Chelsea Heights',
  'Clarinda', 'Clayton South', 'Dingley Village', 'Edithvale', 'Heatherton', 'Mentone', 'Moorabbin',
  'Moorabbin Airport', 'Mordialloc', 'Parkdale', 'Patterson Lakes', 'Waterways',
  // Greater Dandenong
  'Bangholme', 'Dandenong', 'Dandenong North', 'Dandenong South', 'Keysborough', 'Noble Park',
  'Noble Park North', 'Springvale', 'Springvale South',
  // Casey
  'Beaconsfield', 'Berwick', 'Blind Bight', 'Botanic Ridge', 'Cannons Creek', 'Clyde', 'Clyde North',
  'Cranbourne', 'Cranbourne East', 'Cranbourne North', 'Cranbourne South', 'Cranbourne West',
  'Devon Meadows', 'Doveton', 'Endeavour Hills', 'Eumemmerring', 'Five Ways', 'Hallam',
  'Hampton Park', 'Harkaway', 'Junction Village', 'Lynbrook', 'Lyndhurst', 'Lysterfield South',
  'Narre Warren', 'Narre Warren North', 'Narre Warren South', 'Pearcedale', 'Tooradin', 'Warneet',
  // Frankston
  'Carrum Downs', 'Frankston', 'Frankston North', 'Frankston South', 'Karingal', 'Langwarrin',
  'Langwarrin South', 'Sandhurst', 'Seaford', 'Skye',
  // Mornington Peninsula
  'Arthurs Seat', 'Balnarring', 'Balnarring Beach', 'Baxter', 'Bittern', 'Blairgowrie', 'Boneo',
  'Cape Schanck', 'Capel Sound', 'Crib Point', 'Dromana', 'Fingal', 'Flinders', 'Hastings',
  'HMAS Cerberus', 'Main Ridge', 'McCrae', 'Merricks', 'Merricks Beach', 'Merricks North',
  'Moorooduc', 'Mornington', 'Mount Eliza', 'Mount Martha', 'Point Leo', 'Portsea', 'Red Hill',
  'Red Hill South', 'Rosebud', 'Rye', 'Safety Beach', 'Shoreham', 'Somers', 'Somerville', 'Sorrento',
  'St Andrews Beach', 'Tootgarook', 'Tyabb',
  // Cardinia
  'Beaconsfield Upper', 'Bunyip', 'Cardinia', 'Cockatoo', 'Emerald', 'Garfield', 'Gembrook',
  'Koo Wee Rup', 'Lang Lang', 'Maryknoll', 'Nar Nar Goon', 'Officer', 'Officer South', 'Pakenham',
  'Pakenham South', 'Pakenham Upper', 'Tynong',
  // Yarra Ranges
  'Badger Creek', 'Belgrave', 'Belgrave Heights', 'Belgrave South', 'Chirnside Park', 'Coldstream',
  'Ferny Creek', 'Healesville', 'Kalorama', 'Kilsyth', 'Lilydale', 'Montrose', 'Mooroolbark',
  'Mount Dandenong', 'Mount Evelyn', 'Olinda', 'Sassafras', 'Seville', 'Silvan', 'Tecoma', 'Upwey',
  'Wandin East', 'Wandin North', 'Warburton', 'Woori Yallock', 'Yarra Glen', 'Yarra Junction'
];

function normalize(suburb) {
  return (suburb || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,]+$/, '');
}

const MELBOURNE_SUBURB_PARTNER = {};
LIAM_SUBURBS.forEach(s => { MELBOURNE_SUBURB_PARTNER[normalize(s)] = LIAM; });
JUSTINE_SUBURBS.forEach(s => { MELBOURNE_SUBURB_PARTNER[normalize(s)] = JUSTINE; });

function isVicState(rawState) {
  const s = normalize(rawState);
  return s === 'victoria' || s === 'vic';
}

// The one function every caller (incoming leads, the centre backfill
// script, the frontend's territory-map endpoint) should use — never read
// MELBOURNE_SUBURB_PARTNER directly, so the VIC-check and the "outside the
// metro split falls back to Justine" rule can't be forgotten at a new call site.
function partnerForSuburbState(suburb, state) {
  if (!isVicState(state)) return null;
  return MELBOURNE_SUBURB_PARTNER[normalize(suburb)] || JUSTINE;
}

module.exports = { LIAM, JUSTINE, MELBOURNE_SUBURB_PARTNER, partnerForSuburbState, isVicState, normalize };
