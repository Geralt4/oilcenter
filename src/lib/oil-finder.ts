/*
 * «Ποιο λάδι χρειάζεται το όχημά μου;» — the choices of the vehicle form. Pure module: the client form renders
 * them, the server action validates against them and writes the Greek label into the message.
 *
 * Why a form and not a make/model/engine selector like the big parts sites: those run on a licensed vehicle
 * database. What this shop has instead is a person who knows the answer — the form just hands him the question.
 */

export const VEHICLE_TYPES = {
  car: 'Αυτοκίνητο',
  moto: 'Μοτοσυκλέτα / Scooter',
  van: 'Φορτηγό / Επαγγελματικό',
  agri: 'Αγροτικό μηχάνημα',
  boat: 'Σκάφος / Εξωλέμβια',
  other: 'Άλλο',
} as const;

export const FUELS = {
  petrol: 'Βενζίνη',
  diesel: 'Πετρέλαιο (Diesel)',
  hybrid: 'Υβριδικό',
  gas: 'Υγραέριο / Φυσικό αέριο',
  unsure: 'Δεν είμαι σίγουρος',
} as const;

export const NEEDS = {
  'engine-oil': 'Λάδι κινητήρα',
  'gear-oil': 'Βαλβολίνη / λάδι κιβωτίου',
  coolant: 'Αντιψυκτικό',
  'brake-fluid': 'Υγρά φρένων',
  service: 'Όλα για το σέρβις',
  other: 'Κάτι άλλο',
} as const;

export type VehicleType = keyof typeof VEHICLE_TYPES;
export type Fuel = keyof typeof FUELS;
export type Need = keyof typeof NEEDS;

/** Suggestions only (a <datalist>): the visitor can type anything. */
export const COMMON_MAKES = [
  'Alfa Romeo', 'Audi', 'BMW', 'Chevrolet', 'Citroën', 'Dacia', 'Daihatsu', 'Fiat', 'Ford', 'Honda', 'Hyundai', 'Jeep', 'Kia', 'Lancia', 'Land Rover', 'Lexus', 'Mazda', 'Mercedes-Benz', 'MG', 'Mini',
  'Mitsubishi', 'Nissan', 'Opel', 'Peugeot', 'Porsche', 'Renault', 'Seat', 'Skoda', 'Smart', 'Subaru', 'Suzuki', 'Toyota', 'Volkswagen', 'Volvo',
  'Aprilia', 'Ducati', 'Kawasaki', 'KTM', 'Kymco', 'Piaggio', 'SYM', 'Yamaha',
];
