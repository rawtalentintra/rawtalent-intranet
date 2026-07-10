// One-time seed for the "Our Team" org chart / directory — only used by
// initDatabase() when team_members is empty, so this never overwrites real
// edits made later through the UI. Photos are pulled from teamPhotos.json
// (extracted from the team's HR profile PDF) to keep this file readable.
const photos = require('./teamPhotos.json');

const members = [
  { key: 'liam', name: 'Liam Baxter', position: 'Founder', manager: null, sortOrder: 0 },

  { key: 'sophia', name: 'Sophia', legal_name: 'Banthita Arwae', position: 'Operations Manager', manager: 'liam', sortOrder: 0,
    employment_date: 'August 01, 2024', address: '80/12 ซอยน้ำตกกะทู้ · Soi Charoen, 83120 Phuket City, Thailand', birthdate: 'November 15, 2002',
    device_name: 'MacBook Air M3', headset: 'Jabra Evolve 20se', internet_connection: 'Wifi (AIS)', backup_available: 'Yes',
    backup_types: ["2 Power Banks - They can charge my Mac for 1 time.", "Phone Internet Data - It'll last as long as the government doesn't cut the connection."],
    photo: photos.sophia },

  { key: 'joy', name: 'Joy Victoria', legal_name: 'Joy Victoria', position: 'Business Analyst', manager: 'liam', sortOrder: 1,
    employment_date: 'June 02, 2026', address: '23 Rimando Road, Baguio City, Philippines 2600', birthdate: 'September 13, 1985',
    device_name: 'MacBook Air M2', headset: 'Beats Studio Pro; Bose QuietComfort', internet_connection: 'PLDT', backup_available: 'YES',
    backup_types: ['Power Station', 'Smart Mobile Data'],
    photo: photos.joy },

  { key: 'yuvraj', name: 'Yuvraj Rao', position: 'App Development Lead', manager: 'liam', sortOrder: 2 },
  { key: 'prince', name: 'Prince Kumar', position: 'App Developer', manager: 'yuvraj', sortOrder: 0 },
  { key: 'gwen', name: 'Gwen Stocks', position: 'Workforce Partner (SA)', manager: 'liam', sortOrder: 3 },
  { key: 'jemina', name: 'Jemina Numos', position: 'Email Marketer', manager: 'liam', sortOrder: 4 },

  { key: 'lorie', name: 'Lorie', legal_name: 'Lorina Delara', position: 'Bookings Manager', team: 'AM Team', manager: 'sophia', sortOrder: 0,
    employment_date: 'September 1, 2024', address: '2 St Mary St, Villa Rufina Subd, Lapu-Lapu City', birthdate: 'April 16, 1991',
    device_name: 'MacBook Air M1', headset: 'EKSA H16', internet_connection: 'Globe Fiber', backup_available: 'Yes',
    backup_types: ['Power bank: 1 day', 'UPS Wifi Powerbank: 5-8hours', 'Mobile Data', 'Chromebook: 10-12hours'],
    photo: photos.lorie },

  { key: 'marsha', name: 'Marsha', legal_name: 'Maricel Cleopas', position: 'Talent Consultant', team: 'AM Team', manager: 'lorie', sortOrder: 0,
    employment_date: 'August 24, 2025', address: 'B6L3 Navona Subd., Brgy Calawisan, Lapu-lapu', birthdate: 'May 31, 1993',
    device_name: 'Acer Nitro AN515-57', headset: 'Edifier K800 (USB-wired) | EKSA H16 (wireless)', internet_connection: 'PLDT Fiber', backup_available: 'Yes',
    backup_types: ['EcoFlow River 2 power station with solar panel (up to 4-5 hrs)', 'Smart mobile data', '57,000mAh power bank', 'PC station'],
    photo: photos.marsha },

  { key: 'mary', name: 'Mary', legal_name: 'Mary Stepanie Almodal', position: 'Talent Consultant', team: 'AM Team', manager: 'lorie', sortOrder: 1,
    employment_date: 'March 25, 2026', address: 'Riverside, Poblacion Oriental, Consolacion, Cebu', birthdate: 'August 11, 1993',
    device_name: 'Acer Aspire 5 (currently using a desktop since started)', headset: 'Jabra Evolve2 40', internet_connection: 'Globe Broadband', backup_available: 'Yes',
    backup_types: ['Laptop', 'Globe mobile data'],
    photo: photos.mary },

  { key: 'shienna', name: 'Shienna', legal_name: 'Shienna Dela Cruz', position: 'Talent Consultant', team: 'AM Team', manager: 'lorie', sortOrder: 2,
    employment_date: 'March 25, 2026', address: 'Block 201, Lot 8, 2nd St, Metrogate, Subd. Brgy. Capaya', birthdate: 'May 23, 1988',
    device_name: 'MacBook Pro M2', headset: 'Logitech H111', internet_connection: 'Converge', backup_available: 'Yes',
    backup_types: ['Power station, power banks, backup internet, backup laptop (MacBook Air M1), pocket wifi, mobile data — last up to 24hrs'],
    photo: photos.shienna },

  { key: 'amtohire', name: 'To Hire', position: 'Talent Consultant', team: 'AM Team', manager: 'lorie', sortOrder: 3, status: 'to_hire' },

  { key: 'adrianne', name: 'Adzi', legal_name: 'Adrianne Kaye Estrella', position: 'Quality Manager', team: 'PM Team', manager: 'joy', sortOrder: 0,
    employment_date: 'September 1, 2024', address: '72 Daisy St, Pajac, Lapu-Lapu City', birthdate: 'November 15, 1996',
    device_name: 'MacBook Air M1', headset: 'EKSA H16', internet_connection: 'Globe Fiber', backup_available: 'Yes',
    backup_types: ['Power bank: 1 day', 'UPS Wifi Powerbank: 5-8hours', 'Mobile Data', 'Chromebook: 10-12hours'],
    photo: photos.adrianne },

  { key: 'vicky', name: 'Vicky', legal_name: 'Vicky Viray', position: 'Talent Consultant', team: 'PM Team', manager: 'adrianne', sortOrder: 0,
    employment_date: 'August 24, 2025', address: '0202 Bumasgao Poblacion Tuba Benguet', birthdate: 'October 04, 1995',
    device_name: 'Dell Latitude 5430', headset: 'Jabra Evolve 20', internet_connection: 'Converge', backup_available: 'Yes',
    backup_types: ['2 power banks - lasts for 1 day', '1 power station - can fully charge my laptop and 1 powerbank', 'Mobile data for wifi', 'MacBook Pro & PC station'],
    photo: photos.vicky },

  { key: 'gelliane', name: 'Gelliane', legal_name: 'Mary Gelliane Saranillo', position: 'Talent Consultant', team: 'PM Team', manager: 'adrianne', sortOrder: 1,
    employment_date: 'March 25, 2026', address: 'Lucena Homes, Lower Pakigne, Minglanilla, Cebu', birthdate: 'August 13, 1997',
    device_name: 'MacBook Air M3', headset: 'JBL', internet_connection: 'Converge', backup_available: 'Yes',
    backup_types: ['Laptop', 'Globe Mobile Data'],
    photo: photos.gelliane },

  { key: 'dona', name: 'Dona', legal_name: 'Dona Mari Reyta', position: 'Talent Consultant', team: 'PM Team', manager: 'adrianne', sortOrder: 2,
    employment_date: 'March 25, 2026', address: 'Blk 9 Lot 1A Villa Olympia Subd. Phase 4 San Pedro', birthdate: 'July 13, 1988',
    device_name: 'MacBook Air M1', headset: 'Plantronics CS510; Beats Studio Pro', internet_connection: 'PLDT Home Fibre', backup_available: 'Yes',
    backup_types: ['Power station - 17-24 hours', 'Power banks', 'Pocket Wifi and Mobile Data'],
    photo: photos.dona },

  { key: 'izza', name: 'Izza', legal_name: 'Merizza Delos Reyes', position: 'Talent Consultant', team: 'PM Team', manager: 'adrianne', sortOrder: 3,
    employment_date: 'June 01, 2026', address: 'Block 1 Lot 38 Ph8 Micara Ave, Micara Estates, Sahud Ulan, Tanza, Cavite, 4108', birthdate: 'March 07, 1988',
    device_name: 'HP Laptop 15-fc0xxx', headset: 'Lenovo Services Binaural Voice In-line Headset', internet_connection: 'Converge (400 Mbps)', backup_available: 'YES',
    backup_types: ['Backup prepaid wifi & power station', 'Smart and Globe prepaid wifi'],
    photo: photos.izza }
];

module.exports = members;
