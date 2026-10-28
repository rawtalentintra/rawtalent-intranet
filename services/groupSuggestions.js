// Suggested group from the centre name (Joy, 29 Oct). The one editable list of
// operator brands. Only brands checked on the operator's own website (29 Oct)
// are listed; unverified ones (G8/Affinity sub-brands, Story House, Nido, YMCA,
// TheirCare, Bambini) are left out on purpose. A suggestion never overwrites a
// category someone has set; the consultant confirms it in the wash form.
const BRANDS = [
  { re: /\bgoodstart\b/i, operator: 'Goodstart', group: 'big' },                     // goodstart.org.au: 650+ centres
  { re: /\bguardian child ?care\b/i, operator: 'Guardian', group: 'big' },             // guardian.edu.au: centres in 5 states/territories
  { re: /\bonly about children\b/i, operator: 'Only About Children', group: 'big' },  // oac.edu.au: 75+ campuses
  { re: /\bbusy bees\b/i, operator: 'Busy Bees', group: 'big' },                       // busybees.edu.au: national group
  { re: /\bedge early learning\b/i, operator: 'Edge Early Learning', group: 'medium' }, // edgeearlylearning.com.au: 70 centres (medium, as asked)
  { re: /\bsparkways\b/i, operator: 'Sparkways', group: 'medium' }                     // sparkways.org.au: ~45 early learning services
];

function suggestGroup(centreName) {
  const b = BRANDS.find(x => x.re.test(String(centreName || '')));
  return b ? { group: b.group, operator: b.operator } : null;
}

module.exports = { BRANDS, suggestGroup };
