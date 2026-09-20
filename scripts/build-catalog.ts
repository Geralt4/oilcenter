/*
 * Builds the shop's starting catalogue from the client's product photos.
 *
 *   catalog/labels/*.json   what is printed on each photographed label (one entry per photo)
 *   Tsakiridis /*.zip       the raw photos (git-ignored)
 *        ↓
 *   public/catalog/*.webp   normalised 1000×1000 product images
 *   catalog/catalog.json    brands, categories, products + size variants → consumed by scripts/seed.ts
 *
 * PRICES WRITTEN HERE ARE PLACEHOLDERS derived from a rough market heuristic. They are seeded with
 * price_verified = false and the storefront ships in demo mode until the owner confirms them.
 *
 *   npm run catalog:build              (unzips the photos into .cache/photos on first run)
 *   npm run catalog:build -- --photos /path/to/unzipped --skip-images
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeProductPhoto, resizePhoto, type NormalizeOptions } from '../src/lib/images';
import { normalizeText, parseVolumeMl, slugify } from '../src/lib/utils';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const argValue = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const SKIP_IMAGES = args.includes('--skip-images');
const PHOTOS_DIR = path.resolve(argValue('--photos') ?? '.cache/photos');
const OUT_IMAGES = path.join(ROOT, 'public/catalog');

type Label = {
  file: string; brand: string; name: string; viscosity: string | null; pack: string | null; pack_confidence?: string;
  kind: string; base: string | null; specs: string[]; label_text?: string; group: string; issues?: string[]; note?: string; confidence?: number;
};

// ─── Taxonomy ────────────────────────────────────────────────────────────────
const CATEGORIES = [
  { slug: 'lipantika-kinitira', name: 'Λιπαντικά Κινητήρα', icon: 'engine', description: 'Λάδια κινητήρα για κάθε όχημα: επιβατικά, μοτοσυκλέτες, επαγγελματικά και αγροτικά. Συνθετικά, ημισυνθετικά και ορυκτέλαια από τις κορυφαίες μάρκες.' },
  { slug: 'lipantika-epivatikon', parent: 'lipantika-kinitira', name: 'Επιβατικά Αυτοκίνητα', icon: 'car', description: 'Λιπαντικά κινητήρα για βενζινοκίνητα, πετρελαιοκίνητα, υβριδικά και LPG επιβατικά. Βρείτε το σωστό ιξώδες (0W-20, 5W-30, 5W-40, 10W-40…) και τις εγκρίσεις που ζητά ο κατασκευαστής σας.' },
  { slug: 'lipantika-motosykleton-4t', parent: 'lipantika-kinitira', name: 'Μοτοσυκλέτες & Scooter 4T', icon: 'moto', description: 'Λιπαντικά για τετράχρονους κινητήρες μοτοσυκλετών και scooter, με προδιαγραφές JASO MA/MA2 και MB.' },
  { slug: 'lipantika-2t', parent: 'lipantika-kinitira', name: 'Δίχρονα 2T & Εξωλέμβια', icon: 'twostroke', description: 'Λάδια μίξης και αυτόματης λίπανσης για δίχρονους κινητήρες: scooter, μοτοσυκλέτες, εξωλέμβιες και μηχανήματα κήπου.' },
  { slug: 'lipantika-epaggelmatikon', parent: 'lipantika-kinitira', name: 'Επαγγελματικά & Φορτηγά', icon: 'truck', description: 'Λιπαντικά βαρέος τύπου για πετρελαιοκινητήρες φορτηγών, λεωφορείων, ταξί και μηχανημάτων έργου. Διαθέσιμα και σε δοχεία 20 λίτρων.' },
  { slug: 'lipantika-agrotikon', parent: 'lipantika-kinitira', name: 'Αγροτικά Μηχανήματα', icon: 'tractor', description: 'Πολυχρηστικά λιπαντικά STOU / UTTO για τρακτέρ και αγροτικά μηχανήματα.' },
  { slug: 'valvolines-kivotia', name: 'Βαλβολίνες & Κιβώτια', icon: 'gear', description: 'Βαλβολίνες για μηχανικά κιβώτια και διαφορικά, υγρά αυτόματων κιβωτίων (ATF), CVT και διπλού συμπλέκτη (DCT/DSG).' },
  { slug: 'valvolines', parent: 'valvolines-kivotia', name: 'Βαλβολίνες', icon: 'gear', description: 'Βαλβολίνες GL-3, GL-4 και GL-5 για μηχανικά κιβώτια ταχυτήτων, διαφορικά και άξονες: 75W-80, 75W-90, 80W-90, 85W-90, 75W-140.' },
  { slug: 'atf-cvt-dct', parent: 'valvolines-kivotia', name: 'ATF · CVT · DCT', icon: 'atf', description: 'Υγρά για αυτόματα κιβώτια (DEXRON, MERCON), κιβώτια συνεχούς μεταβολής (CVT), διπλού συμπλέκτη (DCT/DSG) και υδραυλικά τιμόνια.' },
  { slug: 'ydraulika-ladia', name: 'Υδραυλικά Λάδια', icon: 'hydraulic', description: 'Υδραυλικά λάδια HLP / HVLP ιξώδους 32, 46 και 68 για ανυψωτικά, πρέσες, μηχανήματα έργου και βιομηχανικές εφαρμογές.' },
  { slug: 'antipsyktika-ygra', name: 'Αντιψυκτικά & Υγρά', icon: 'coolant', description: 'Αντιψυκτικά (paraflu) όλων των τύπων, υγρά φρένων και υγρά υαλοκαθαριστήρων.' },
  { slug: 'antipsyktika-paraflu', parent: 'antipsyktika-ygra', name: 'Αντιψυκτικά (Paraflu)', icon: 'coolant', description: 'Αντιψυκτικά – ψυκτικά υγρά κινητήρα G11, G12+, G13 και ειδικά για ιαπωνικά οχήματα, έτοιμα προς χρήση. Μην αναμειγνύετε διαφορετικούς τύπους.' },
  { slug: 'ygra-frenon', parent: 'antipsyktika-ygra', name: 'Υγρά Φρένων', icon: 'brake', description: 'Υγρά φρένων DOT 4 και DOT 5.1.' },
  { slug: 'ygra-yalokatharistiron', parent: 'antipsyktika-ygra', name: 'Υγρά Υαλοκαθαριστήρων', icon: 'fluids', description: 'Υγρά καθαρισμού παρμπρίζ για κάθε εποχή.' },
  { slug: 'chimika-prostheta', name: 'Χημικά & Πρόσθετα', icon: 'chemicals', description: 'Πρόσθετα καυσίμου και λαδιού, καθαριστικά συστημάτων, στεγανωτικά και σπρέι συντήρησης από Liqui Moly, Pro-Tec, Mannol και MAG 1.' },
  { slug: 'prostheta-kafsimou', parent: 'chimika-prostheta', name: 'Πρόσθετα Καυσίμου', icon: 'fuel', description: 'Καθαριστικά μπεκ και βαλβίδων, βελτιωτικά οκτανίων, πρόσθετα πετρελαίου, προστασία φίλτρου σωματιδίων (DPF) και προϊόντα για υγραεριοκίνηση (LPG).' },
  { slug: 'prostheta-ladiou', parent: 'chimika-prostheta', name: 'Πρόσθετα Λαδιού', icon: 'engine', description: 'Καθαριστικά κινητήρα (flush), στεγανωτικά διαρροών λαδιού, πρόσθετα για υδραυλικά ωστήρια και αντιτριβικές προστασίες.' },
  { slug: 'frontida-psygeiou', parent: 'chimika-prostheta', name: 'Φροντίδα Ψυγείου', icon: 'coolant', description: 'Καθαριστικά και στεγανωτικά για το κύκλωμα ψύξης.' },
  { slug: 'prostheta-kivotiou', parent: 'chimika-prostheta', name: 'Πρόσθετα Κιβωτίου', icon: 'gear', description: 'Στεγανωτικά διαρροών και πρόσθετα για ευκολότερη αλλαγή ταχυτήτων.' },
  { slug: 'sprei-katharistika', parent: 'chimika-prostheta', name: 'Σπρέι & Καθαριστικά', icon: 'spray', description: 'Καθαριστικά φρένων και εξαρτημάτων, σπρέι επαφών, σιλικόνης, λευκού γράσου, αλυσίδας και αιθέρας εκκίνησης.' },
  { slug: 'peripoiisi-ac', parent: 'chimika-prostheta', name: 'Περιποίηση A/C', icon: 'spray', description: 'Καθαριστικά και αποσμητικά για το σύστημα κλιματισμού.' },
  { slug: 'grasa', name: 'Γράσα', icon: 'grease', description: 'Γράσα λιθίου και πολλαπλών χρήσεων για ρουλεμάν, αρθρώσεις και γενική λίπανση.' },
] as const;

const KIND: Record<string, { category: string; short: (v: string) => string; keywords: string; density: number; advice: string }> = (() => {
  const OIL_ADVICE = 'Πριν την αγορά συμβουλευτείτε το βιβλίο συντήρησης του οχήματός σας για το σωστό ιξώδες και τις απαιτούμενες προδιαγραφές — ή καλέστε μας και θα σας προτείνουμε το κατάλληλο λιπαντικό.';
  const ADDITIVE_ADVICE = 'Ακολουθήστε τις οδηγίες χρήσης και τη δοσολογία που αναγράφονται στη συσκευασία.';
  const v = (s: string) => (s ? ` ${s}` : '');
  return {
    engine_oil_car: { category: 'lipantika-epivatikon', short: (x) => `Λιπαντικό κινητήρα${v(x)} για επιβατικά αυτοκίνητα`, keywords: 'λαδι λαδια λιπαντικο λιπαντικα κινητηρα μηχανης αυτοκινητου motor oil', density: 0.87, advice: OIL_ADVICE },
    engine_oil_moto_4t: { category: 'lipantika-motosykleton-4t', short: (x) => `Λιπαντικό${v(x)} για τετράχρονους κινητήρες μοτοσυκλετών & scooter`, keywords: 'λαδι λαδια λιπαντικο μοτοσυκλετας μηχανης μοτο scooter σκουτερ 4t τετραχρονο', density: 0.87, advice: OIL_ADVICE },
    engine_oil_moto_2t: { category: 'lipantika-2t', short: () => 'Λιπαντικό για δίχρονους κινητήρες', keywords: 'λαδι μιξης διχρονο 2t δίχρονα εξωλεμβια scooter', density: 0.87, advice: 'Ακολουθήστε την αναλογία μίξης που ορίζει ο κατασκευαστής του κινητήρα.' },
    engine_oil_truck: { category: 'lipantika-epaggelmatikon', short: (x) => `Λιπαντικό${v(x)} για πετρελαιοκινητήρες βαρέος τύπου`, keywords: 'λαδι λιπαντικο φορτηγου επαγγελματικο diesel πετρελαιο βαρεος τυπου', density: 0.88, advice: OIL_ADVICE },
    tractor_oil: { category: 'lipantika-agrotikon', short: (x) => `Πολυχρηστικό λιπαντικό STOU${v(x)} για αγροτικά μηχανήματα`, keywords: 'λαδι τρακτερ αγροτικο stou utto universal tractor', density: 0.88, advice: OIL_ADVICE },
    gear_oil: { category: 'valvolines', short: (x) => `Βαλβολίνη${v(x)} για κιβώτια ταχυτήτων & διαφορικά`, keywords: 'βαλβολινη βαλβολινες κιβωτιο σασμαν διαφορικο gear oil', density: 0.89, advice: 'Ελέγξτε την κατηγορία API GL και το ιξώδες που απαιτεί ο κατασκευαστής του κιβωτίου.' },
    atf: { category: 'atf-cvt-dct', short: () => 'Υγρό αυτόματου κιβωτίου / συστήματος μετάδοσης', keywords: 'atf υγρο αυτοματου κιβωτιου σασμαν cvt dct dsg dexron υδραυλικο τιμονι', density: 0.86, advice: 'Τα υγρά αυτόματων κιβωτίων δεν είναι εναλλάξιμα μεταξύ τους: επιβεβαιώστε την προδιαγραφή που απαιτεί το κιβώτιό σας.' },
    hydraulic_oil: { category: 'ydraulika-ladia', short: () => 'Υδραυλικό λάδι', keywords: 'υδραυλικο λαδι hlp hvlp 32 46 68', density: 0.88, advice: '' },
    coolant: { category: 'antipsyktika-paraflu', short: () => 'Αντιψυκτικό – ψυκτικό υγρό κινητήρα (paraflu)', keywords: 'αντιψυκτικο αντιψυκτικα παραφλου paraflu ψυκτικο υγρο ψυγειου', density: 1.07, advice: 'Μην αναμειγνύετε διαφορετικούς τύπους αντιψυκτικού. Ελέγξτε τον τύπο (G11 / G12 / G13) που απαιτεί ο κατασκευαστής.' },
    screenwash: { category: 'ygra-yalokatharistiron', short: () => 'Υγρό καθαρισμού παρμπρίζ', keywords: 'υγρο υαλοκαθαριστηρων παρμπριζ τζαμιων', density: 1.0, advice: '' },
    brake_fluid: { category: 'ygra-frenon', short: () => 'Υγρό φρένων', keywords: 'υγρο υγρα φρενων dot4 dot 4', density: 1.05, advice: 'Το υγρό φρένων είναι υγροσκοπικό: αντικαθιστάται περιοδικά και το δοχείο φυλάσσεται ερμητικά κλειστό.' },
    fuel_additive: { category: 'prostheta-kafsimou', short: () => 'Πρόσθετο καυσίμου', keywords: 'προσθετο βελτιωτικο καθαριστικο καυσιμου βενζινης πετρελαιου μπεκ', density: 0.85, advice: ADDITIVE_ADVICE },
    oil_additive: { category: 'prostheta-ladiou', short: () => 'Πρόσθετο λαδιού κινητήρα', keywords: 'προσθετο ενισχυτικο λαδιου κινητηρα flush διαρροη', density: 0.9, advice: ADDITIVE_ADVICE },
    cooling_additive: { category: 'frontida-psygeiou', short: () => 'Πρόσθετο συστήματος ψύξης', keywords: 'ψυγειο ψυγειου διαρροη στεγανωτικο καθαριστικο', density: 1.0, advice: ADDITIVE_ADVICE },
    gearbox_additive: { category: 'prostheta-kivotiou', short: () => 'Πρόσθετο κιβωτίου ταχυτήτων', keywords: 'προσθετο κιβωτιου σασμαν διαρροη', density: 0.9, advice: ADDITIVE_ADVICE },
    cleaner_spray: { category: 'sprei-katharistika', short: () => 'Καθαριστικό σπρέι', keywords: 'σπρει σπρευ spray καθαριστικο', density: 0.8, advice: '' },
    lubricant_spray: { category: 'sprei-katharistika', short: () => 'Λιπαντικό σπρέι', keywords: 'σπρει σπρευ spray λιπαντικο γρασο σιλικονη', density: 0.8, advice: '' },
    ac_care: { category: 'peripoiisi-ac', short: () => 'Καθαριστικό – αποσμητικό συστήματος A/C', keywords: 'κλιματισμος air condition ac καθαριστικο αρωματικο', density: 0.8, advice: '' },
    grease: { category: 'grasa', short: () => 'Γράσο πολλαπλών χρήσεων', keywords: 'γρασο γρασα λιθιου ρουλεμαν', density: 0.92, advice: '' },
    other: { category: 'chimika-prostheta', short: () => '', keywords: '', density: 0.9, advice: '' },
  };
})();

const BRANDS: Record<string, { name: string; slug: string; country: string; featured?: boolean; sort: number; description: string }> = {
  accelerate: { name: 'accelerate', slug: 'accelerate', country: 'Γερμανία', featured: true, sort: 1, description: 'Γερμανικής παραγωγής λιπαντικά με επίσημες εγκρίσεις κατασκευαστών. Το Oil Center είναι εξουσιοδοτημένος αντιπρόσωπος της accelerate.' },
  Castrol: { name: 'Castrol', slug: 'castrol', country: 'Ηνωμένο Βασίλειο', featured: true, sort: 2, description: 'EDGE, MAGNATEC, POWER1 και TRANSMAX: από τα πιο αναγνωρίσιμα λιπαντικά παγκοσμίως.' },
  Motul: { name: 'Motul', slug: 'motul', country: 'Γαλλία', featured: true, sort: 3, description: 'Γαλλική εξειδίκευση σε συνθετικά λιπαντικά για αυτοκίνητα και μοτοσυκλέτες: σειρές 8100, 4100, 7100, 5100.' },
  Mobil: { name: 'Mobil', slug: 'mobil', country: 'ΗΠΑ', featured: true, sort: 4, description: 'Mobil 1 και Mobil Super 3000: συνθετικά λιπαντικά κορυφαίας προστασίας.' },
  Shell: { name: 'Shell', slug: 'shell', country: 'Ολλανδία / ΗΒ', featured: true, sort: 5, description: 'Shell Helix HX6, HX7 και Ultra.' },
  Valvoline: { name: 'Valvoline', slug: 'valvoline', country: 'ΗΠΑ', featured: true, sort: 6, description: 'Λιπαντικά κινητήρα, βαλβολίνες και υγρά κιβωτίων από το 1866.' },
  'Liqui Moly': { name: 'Liqui Moly', slug: 'liqui-moly', country: 'Γερμανία', featured: true, sort: 7, description: 'Γερμανικά πρόσθετα, καθαριστικά και λιπαντικά.' },
  Aral: { name: 'Aral', slug: 'aral', country: 'Γερμανία', featured: true, sort: 8, description: 'BlueTronic, SuperTronic και HighTronic με εγκρίσεις γερμανικών κατασκευαστών.' },
  'Petronas Selenia': { name: 'Selenia', slug: 'selenia', country: 'Ιταλία', featured: true, sort: 9, description: 'Τα λιπαντικά πρώτης πλήρωσης του ομίλου Fiat – Alfa Romeo – Lancia – Jeep, από την Petronas.' },
  'Petronas Tutela': { name: 'Petronas Tutela', slug: 'tutela', country: 'Ιταλία', sort: 10, description: 'Βαλβολίνες, υγρά κιβωτίων και γράσα με προδιαγραφές Fiat.' },
  Mannol: { name: 'Mannol', slug: 'mannol', country: 'Γερμανία', featured: true, sort: 11, description: 'Αντιψυκτικά, σπρέι συντήρησης, πρόσθετα και λιπαντικά σε προσιτές τιμές.' },
  Toyota: { name: 'Toyota', slug: 'toyota', country: 'Ιαπωνία', sort: 12, description: 'Γνήσια λιπαντικά κινητήρα Toyota.' },
  GM: { name: 'GM Genuine', slug: 'gm', country: 'ΗΠΑ', sort: 13, description: 'Γνήσια λιπαντικά GM / Opel με προδιαγραφή dexos.' },
  Avista: { name: 'Avista', slug: 'avista', country: 'Γερμανία', sort: 14, description: 'Γερμανικά λιπαντικά: σειρές pace, peer, pulse και pure.' },
  'Pro-Tec': { name: 'Pro-Tec', slug: 'pro-tec', country: 'Γερμανία', sort: 15, description: 'Επαγγελματικά χημικά συντήρησης και καθαρισμού συστημάτων.' },
  'MAG 1': { name: 'MAG 1', slug: 'mag-1', country: 'ΗΠΑ', sort: 16, description: 'Αμερικανικά πρόσθετα και χημικά αυτοκινήτου.' },
  AISIN: { name: 'AISIN', slug: 'aisin', country: 'Ιαπωνία', sort: 17, description: 'Ψυκτικά υγρά ειδικά σχεδιασμένα για ιαπωνικά οχήματα.' },
  Valeo: { name: 'Valeo', slug: 'valeo', country: 'Γαλλία', sort: 18, description: 'Ψυκτικά υγρά Protectiv.' },
  SilverSpin: { name: 'SilverSpin', slug: 'silverspin', country: '', sort: 19, description: '' },
};

// Real copy from the shop's previous website (accelerate dealer page), lightly edited.
const COPY: Record<string, string> = {
  'acc-5w30-longlife': '100% συνθετικό λιπαντικό για σύγχρονους κινητήρες βενζίνης και πετρελαίου του ομίλου VW, καθώς και BMW και Mercedes, με σύστημα άμεσου ψεκασμού υψηλής πίεσης (common rail) και φίλτρο σωματιδίων (DPF).',
  'acc-5w30-ecosyn': '100% συνθετικό λιπαντικό σύγχρονων κινητήρων βενζίνης και πετρελαίου, μεσαίας περιεκτικότητας σε τέφρα, φώσφορο και θείο (Mid SAPS). Ειδικά για πετρελαιοκινητήρες Euro 4 / 5 με φίλτρο σωματιδίων και για κινητήρες με αντλία-μπεκ (Pumpe-Düse), όπως VW 505 01.',
  'acc-5w40-tecsyn': 'Συνθετικό λιπαντικό υψηλής απόδοσης για σύγχρονους κινητήρες βενζίνης και πετρελαίου, με έμφαση στην οικονομία καυσίμου.',
  'acc-10w60-race': '100% συνθετικό λιπαντικό για σύγχρονους κινητήρες βενζίνης, πετρελαίου και turbo, με αντοχή σε ακραίες συνθήκες λειτουργίας. Προτείνεται για αγωνιστική χρήση.',
  'acc-10w40-css': 'Ημισυνθετικό λιπαντικό προηγμένης σύνθεσης, κατάλληλο για όλους τους κινητήρες βενζίνης, πετρελαίου και υγραερίου (LPG). Αξιόπιστη επιλογή για επιβατικά, ταξί και επαγγελματικά οχήματα.',
  'acc-15w40-css': 'Λιπαντικό υψηλής ποιότητας για βενζινοκινητήρες και πετρελαιοκινητήρες ελαφρού φορτίου, καθώς και για κινητήρες LPG, πολυβάλβιδους και turbo.',
  'acc-diesel-hmb-20w50': 'Ενισχυμένο ορυκτέλαιο κατάλληλο για κινητήρες βενζίνης, πετρελαίου και turbo. Εξασφαλίζει αυξημένη προστασία του κινητήρα και μείωση του κόστους συντήρησης.',
  'acc-hlp-68': 'Εξαιρετικής ποιότητας λιπαντικό υδραυλικών και κυκλοφοριακών συστημάτων, ενισχυμένο με πρόσθετα κατά της φθοράς και της διάβρωσης. Κατάλληλο για πρέσες, υδραυλικούς ανελκυστήρες και ναυτιλιακές εφαρμογές.',
  'acc-atf-iii-h': 'Υγρό αυτόματων κιβωτίων ταχυτήτων και υδραυλικών τιμονιών. Συντελεί στην ομαλή λειτουργία του κιβωτίου παρέχοντας τη μέγιστη απόδοση. Κατάλληλο για επιβατικά οχήματα, φορτηγά και χωματουργικά μηχανήματα.',
};
const BASE_OVERRIDE: Record<string, string> = { 'acc-diesel-hmb-20w50': 'mineral' };
const NAME_OVERRIDE: Record<string, string> = { SilverSpin: 'Υγρό Υαλοκαθαριστήρων' };

const BASE_TEXT: Record<string, string> = {
  synthetic: '100% συνθετικό',
  'synthetic-technology': 'συνθετικής τεχνολογίας',
  'semi-synthetic': 'ημισυνθετικό',
  mineral: 'ορυκτέλαιο',
};

// Phone screenshots: cut the status bar / browser chrome off before analysing.
const CROP: Record<string, NormalizeOptions> = {
  'Castrol/Castrol/IMG_8619.PNG': { cropTopPct: 0.22, cropBottomPct: 0.2 },
  'Valvoline/Valvoline/IMG_8544.JPG': { cropTopPct: 0.05 },
  'Protec/Protec/IMG_8626.JPG': { cropTopPct: 0.05 },
};

const FEATURED: Array<(l: Label) => boolean> = [
  (l) => l.brand === 'Castrol' && /EDGE 5W-30 LL/.test(l.name),
  (l) => l.brand === 'Motul' && /8100 X-cess 5W-40/.test(l.name),
  (l) => l.brand === 'Mobil' && /ESP 5W-30/.test(l.name),
  (l) => l.brand === 'Shell' && /Ultra/.test(l.name),
  (l) => l.group === 'acc-5w30-longlife',
  (l) => l.brand === 'Valvoline' && /MaxLife/.test(l.name),
  (l) => l.brand === 'Liqui Moly' && /Injection Cleaner/.test(l.name),
  (l) => l.brand === 'Mannol' && /G12\+/.test(l.name),
  (l) => l.brand === 'Motul' && /7100 4T 10W-40/.test(l.name),
  (l) => l.brand === 'Toyota' && /0W-20/.test(l.name),
  (l) => l.brand === 'Petronas Selenia' && /K Pure Energy/.test(l.name),
  (l) => l.brand === 'Aral' && /SuperTronic/.test(l.name),
];

// ─── Placeholder pricing (EUR for a 1 L pack; other sizes scale from it) ─────
function basePriceEur(l: Label): number {
  const n = `${l.brand} ${l.name}`;
  switch (l.kind) {
    case 'engine_oil_car':
      if (/EDGE|Mobil 1|8100|Helix Ultra|pace/i.test(n)) return 14.9;
      if (l.brand === 'accelerate') return l.base === 'synthetic' || l.base === 'synthetic-technology' ? 8.9 : 6.9;
      if (/HX6|All-Climate|Turbolight|SYN-nergy/i.test(n)) return 8.4;
      if (/Toyota|GM|Selenia/i.test(n)) return 11.9;
      return 10.9;
    case 'engine_oil_moto_4t':
      if (/7100|ULTIMATE|SynPower 4T/i.test(n)) return 15.9;
      if (/Mannol|Avista/i.test(n)) return 7.9;
      return 11.9;
    case 'engine_oil_moto_2t':
      return /Scooter Power|ULTIMATE/i.test(n) ? 13.9 : 9.9;
    case 'engine_oil_truck':
    case 'tractor_oil':
      return 5.6;
    case 'gear_oil':
      if (/Gear 300/i.test(n)) return 21.9;
      if (/CLASSIC/i.test(n)) return 5.2;
      return /Motul|Castrol|Tutela/i.test(n) ? 14.9 : 10.9;
    case 'atf':
      return /DCT|CVT|DUAL/i.test(n) ? 15.9 : 11.9;
    case 'hydraulic_oil':
      return 4.6;
    case 'coolant':
      return /AISIN/i.test(n) ? 5.8 : /Liqui/i.test(n) ? 4.6 : 3.9;
    case 'screenwash':
      return 1.2;
    case 'brake_fluid':
      return 11.8;
    case 'grease':
      return 9.9;
    default:
      return 0; // chemicals are priced per unit below
  }
}

function unitPriceEur(l: Label): number {
  const n = `${l.brand} ${l.name}`;
  if (/Pro-Line/i.test(n)) return 18.9;
  if (l.brand === 'Liqui Moly') return /Radiator|Valve/i.test(n) ? 8.9 : 12.9;
  if (l.brand === 'Pro-Tec') return /Easy Gear|GOSL/i.test(n) ? 11.9 : /NEPS|OXICAT/i.test(n) ? 19.9 : 14.9;
  if (l.brand === 'MAG 1') return 6.9;
  if (l.brand === 'Mannol') return /Montage|White Grease/i.test(n) ? 5.9 : 4.9;
  return 7.9;
}

const charm = (eur: number) => Math.max(190, Math.round(eur) * 100 - 10); // 14.37 → 13.90 €

function priceCents(l: Label, ml: number | null): number {
  const perLitre = basePriceEur(l);
  if (!perLitre || !ml) return charm(unitPriceEur(l));
  const litres = ml / 1000;
  const factor = litres <= 1 ? litres : litres <= 2 ? 1.9 : litres <= 4 ? 3.6 : litres <= 5 ? 4.3 : 15 * (litres / 20);
  return charm(perLitre * factor);
}

function weightGrams(l: Label, ml: number | null): number {
  if (!ml) return 500;
  const packaging = ml >= 20000 ? 1200 : ml >= 4000 ? 260 : ml >= 1000 ? 80 : 70;
  return Math.round((ml * (KIND[l.kind] ?? KIND.other).density + packaging) / 10) * 10;
}

const SPEC_PREFIX: Array<[RegExp, string]> = [[/^(A\d\/B\d|A\d|C\d|E\d)$/i, 'ACEA ']];
function cleanSpec(s: string): string {
  let out = s.trim().replace(/\s+/g, ' ');
  for (const [re, prefix] of SPEC_PREFIX) if (re.test(out)) out = prefix + out.toUpperCase();
  return out.replace(/^Erfüllt /i, '').replace(/^Meets /i, '');
}

// ─── Build ───────────────────────────────────────────────────────────────────
function ensurePhotos() {
  if (existsSync(PHOTOS_DIR) && readdirSync(PHOTOS_DIR).length) return;
  const zips = path.join(ROOT, 'Tsakiridis ');
  if (!existsSync(zips)) throw new Error(`Photos not found. Pass --photos <dir> or place the client zips in "${zips}".`);
  mkdirSync(PHOTOS_DIR, { recursive: true });
  for (const zip of readdirSync(zips).filter((f) => f.endsWith('.zip'))) {
    const dest = path.join(PHOTOS_DIR, zip.replace(/\.zip$/, '').trim());
    execFileSync('unzip', ['-q', '-o', path.join(zips, zip), '-d', dest]);
  }
}

async function main() {
  if (!SKIP_IMAGES) ensurePhotos();
  const labelsDir = path.join(ROOT, 'catalog/labels');
  const labels: Label[] = readdirSync(labelsDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((f) => JSON.parse(readFileSync(path.join(labelsDir, f), 'utf8')) as Label[]);

  const groups = new Map<string, Label[]>();
  for (const l of labels) groups.set(l.group, [...(groups.get(l.group) ?? []), l]);

  if (!SKIP_IMAGES) {
    rmSync(OUT_IMAGES, { recursive: true, force: true });
    mkdirSync(OUT_IMAGES, { recursive: true });
  }

  const usedSlugs = new Set<string>();
  const usedSkus = new Set<string>();
  const products = [];
  let imageCount = 0;

  for (const [group, items] of groups) {
    const head = items[0];
    const brand = BRANDS[head.brand];
    if (!brand) throw new Error(`Unknown brand "${head.brand}" (${head.file})`);
    const kind = KIND[head.kind] ?? KIND.other;
    const name = NAME_OVERRIDE[head.brand] ?? head.name.replace(/\s+/g, ' ').trim();

    // "Mobil" + "Mobil 1 ESP" must not become mobil-mobil-1-esp
    let slug = slugify(name.toLowerCase().startsWith(brand.name.toLowerCase()) ? name : `${brand.name} ${name}`);
    while (usedSlugs.has(slug)) slug += '-x';
    usedSlugs.add(slug);

    // Best photo first: skip phone screenshots when a clean duplicate exists, studio shots before shop-counter scenes.
    const isScreenshotDupe = (l: Label) => (l.issues ?? []).includes('phone_screenshot_ui') && (l.issues ?? []).some((i) => i.startsWith('duplicate_of'));
    const usable = items.filter((l) => !isScreenshotDupe(l));
    const rank = (l: Label) => ((l.issues ?? []).includes('in_store_photo') ? 2 : (l.issues ?? []).some((i) => i.startsWith('duplicate_of')) ? 1 : 0);
    usable.sort((a, b) => rank(a) - rank(b));

    const images: string[] = [];
    const variantByLabel = new Map<string, { label: string; volumeMl: number | null; image: string; source: Label }>();

    for (const l of usable) {
      const packs = (l.pack ?? '').split('+').map((p) => p.trim()).filter(Boolean);
      const fileSlug = `${slug}${packs.length === 1 ? `-${slugify(packs[0])}` : ''}`;
      let url = `/catalog/${fileSlug}.webp`;
      for (let i = 2; images.includes(url); i++) url = `/catalog/${fileSlug}-${i}.webp`;
      images.push(url);

      if (!SKIP_IMAGES) {
        const src = path.join(PHOTOS_DIR, l.file);
        const result = await normalizeProductPhoto(src, CROP[l.file] ?? {});
        writeFileSync(path.join(ROOT, 'public', url), result.data);
        imageCount++;
      }

      for (const pack of packs.length ? packs : ['']) {
        const label = pack || 'Τεμάχιο';
        if (variantByLabel.has(label)) continue;
        const ml = pack && !/\d\s*g$/i.test(pack) ? parseVolumeMl(pack) : null;
        variantByLabel.set(label, { label, volumeMl: ml, image: url, source: l });
      }
    }

    const variants = [...variantByLabel.values()]
      .sort((a, b) => (a.volumeMl ?? 0) - (b.volumeMl ?? 0))
      .map((v) => {
        let sku = `${slug}-${slugify(v.label)}`.toUpperCase().slice(0, 60);
        while (usedSkus.has(sku)) sku += 'X';
        usedSkus.add(sku);
        return { sku, label: v.label, volumeMl: v.volumeMl, priceCents: priceCents(v.source, v.volumeMl), weightGrams: weightGrams(v.source, v.volumeMl), image: v.image };
      });

    const specs = [...new Set(items.flatMap((l) => l.specs ?? []).map(cleanSpec).filter(Boolean))];
    const base = BASE_OVERRIDE[group] ?? items.find((l) => l.base)?.base ?? null;
    const viscosity = items.find((l) => l.viscosity)?.viscosity ?? null;

    const short = kind.short(viscosity ?? '') + (base ? `, ${BASE_TEXT[base]}` : '') + '.';
    const paragraphs = [
      COPY[group] ?? `${brand.name} ${name} — ${short.charAt(0).toLowerCase()}${short.slice(1)}`,
      specs.length ? `Προδιαγραφές και εγκρίσεις όπως αναγράφονται στη συσκευασία: ${specs.join(' · ')}.` : '',
      kind.advice,
    ].filter(Boolean);

    const notes = [
      ...new Set([
        ...items.map((l) => l.note ?? '').filter(Boolean),
        ...items.filter((l) => l.pack_confidence === 'inferred' && !l.note).map((l) => `Η συσκευασία «${l.pack}» είναι εκτίμηση από το σχήμα του δοχείου — επιβεβαιώστε.`),
        ...items.filter((l) => !l.pack).map(() => 'Η χωρητικότητα της συσκευασίας δεν αναγράφεται στη φωτογραφία — συμπληρώστε την.'),
        ...items.filter((l) => (l.confidence ?? 1) < 0.7).map((l) => `Χαμηλή βεβαιότητα ανάγνωσης ετικέτας (${Math.round((l.confidence ?? 0) * 100)}%) — ελέγξτε ονομασία και ιξώδες με το φυσικό προϊόν.`),
      ]),
    ];

    const categoryName = CATEGORIES.find((c) => c.slug === kind.category)?.name ?? '';
    products.push({
      slug,
      name,
      brand: brand.slug,
      category: kind.category,
      viscosity,
      baseType: base,
      specs,
      shortDescription: short,
      description: paragraphs.join('\n\n'),
      featured: FEATURED.some((test) => items.some(test)),
      internalNotes: notes.join('\n') || null,
      searchText: normalizeText([brand.name, head.brand, name, viscosity ?? '', viscosity?.replace('-', '') ?? '', specs.join(' '), categoryName, kind.keywords, variants.map((v) => v.label).join(' ')].join(' ')),
      images,
      variants,
    });
  }

  // Shop photos for the home / about pages (taken on the shop counter).
  if (!SKIP_IMAGES) {
    const shopDir = path.join(ROOT, 'public/shop');
    mkdirSync(shopDir, { recursive: true });
    const shots: Array<[string, string, number, number?]> = [
      ['Oilcenter.gr/Oilcenter.gr/46822BA0-7F2A-4AE6-8CFF-8605176DB334.PNG', 'counter-mobil-1.webp', 1086],
      ['Oilcenter.gr/Oilcenter.gr/IMG_5670.PNG', 'counter-mobil-esp.webp', 936],
      ['Oilcenter.gr/Oilcenter.gr/IMG_5737.PNG', 'counter-mobil-super.webp', 959],
    ];
    for (const [src, out, width] of shots) writeFileSync(path.join(shopDir, out), await resizePhoto(path.join(PHOTOS_DIR, src), width));
  }

  const usedBrands = new Set(products.map((p) => p.brand));
  const catalog = {
    generatedAt: new Date().toISOString(),
    notice: 'Prices are PLACEHOLDERS (price_verified=false). Pack sizes marked in internalNotes were inferred, not read.',
    brands: Object.values(BRANDS).filter((b) => usedBrands.has(b.slug)),
    categories: CATEGORIES,
    products: products.sort((a, b) => a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name)),
  };
  writeFileSync(path.join(ROOT, 'catalog/catalog.json'), JSON.stringify(catalog, null, 2));

  const variantTotal = products.reduce((n, p) => n + p.variants.length, 0);
  console.log(`catalog.json: ${products.length} products · ${variantTotal} variants · ${catalog.brands.length} brands · ${imageCount} images written`);
  console.log(`flagged for owner review: ${products.filter((p) => p.internalNotes).length} products`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
