import {
  Bike, Boxes, Car, Cog, Droplet, Droplets, FlaskConical, Fuel, Gauge, Snowflake, SprayCan, Thermometer, Tractor, Truck, Wrench, Zap,
  type LucideIcon,
} from 'lucide-react';

/** Keys stored in categories.icon. Add here to make a new icon selectable in the admin. */
export const CATEGORY_ICONS: Record<string, { icon: LucideIcon; label: string }> = {
  engine: { icon: Droplet, label: 'Λάδι κινητήρα' },
  car: { icon: Car, label: 'Αυτοκίνητο' },
  moto: { icon: Bike, label: 'Μοτοσυκλέτα' },
  twostroke: { icon: Zap, label: 'Δίχρονο' },
  truck: { icon: Truck, label: 'Φορτηγό' },
  tractor: { icon: Tractor, label: 'Τρακτέρ' },
  gear: { icon: Cog, label: 'Κιβώτιο' },
  atf: { icon: Gauge, label: 'Αυτόματο κιβώτιο' },
  hydraulic: { icon: Wrench, label: 'Υδραυλικά' },
  coolant: { icon: Snowflake, label: 'Αντιψυκτικό' },
  fluids: { icon: Droplets, label: 'Υγρά' },
  brake: { icon: Thermometer, label: 'Υγρά φρένων' },
  chemicals: { icon: FlaskConical, label: 'Χημικά' },
  fuel: { icon: Fuel, label: 'Καύσιμο' },
  spray: { icon: SprayCan, label: 'Σπρέι' },
  grease: { icon: Boxes, label: 'Γράσα' },
};

export function CategoryIcon({ name, className }: { name?: string | null; className?: string }) {
  const Icon = (name && CATEGORY_ICONS[name]?.icon) || Droplet;
  return <Icon className={className} aria-hidden="true" />;
}
