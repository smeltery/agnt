export type PetAnimation = {
  row: number;
  frames: number;
  fps: number;
  loop: boolean;
};

export type PetManifest = {
  schema: string;
  name: string;
  slug: string;
  spritesheet: {
    file: string;
    width: number;
    height: number;
    columns: number;
    rows: number;
    cellWidth: number;
    cellHeight: number;
  };
  animations: Record<string, PetAnimation>;
  stateMap: Record<string, string>;
};

export async function loadPetManifest(url: string): Promise<PetManifest> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load pet manifest: ${res.status}`);
  }
  return res.json();
}
