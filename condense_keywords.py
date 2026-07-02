#!/usr/bin/env python3
"""
Condense near-duplicate AI keywords in the manifests into canonical names,
e.g. "tires", "alloy wheels", "wheel detail" all become "wheels".

You normally never run this by hand: describe_images.py runs it automatically
after writing new keywords. Run it manually only after editing the MERGES map
below (to apply new merge rules to existing keywords).

Safe to re-run any time. Backs up both manifests to backups/ before writing.
Only touches the "keywords" field.

Usage:
  python3 condense_keywords.py            # apply
  python3 condense_keywords.py --dry-run  # show what would change, write nothing
"""

import json
import sys
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(__file__).parent
MANIFESTS = {
    "toyota": BASE_DIR / "Toyota" / "manifest.json",
    "lexus": BASE_DIR / "Lexus" / "manifest.json",
}
BACKUP_DIR = BASE_DIR / "backups"

# canonical keyword -> variants that should become it (exact match, lowercase)
MERGES = {
    "wheels": [
        "tires", "tire", "wheel", "alloy wheel", "alloy wheels", "alloy rim",
        "black alloy wheel", "black alloy wheels", "black wheel", "black wheels",
        "bronze alloy wheel", "bronze wheels", "luxury alloy wheel", "luxury alloy rim",
        "lexus alloy wheel", "multi-spoke rim", "multi-spoke alloy wheel",
        "silver spoke wheel", "wheel detail", "wheel detail shot", "wheel close-up",
        "trd wheel detail", "tire closeup", "performance tire", "premium tire",
        "all-terrain tire", "yokohama tire", "michelin tires",
        "michelin pilot sport 4", "michelin pilot super sport", "dunlop tire",
        "bridgestone tire",
    ],
    "accessories": [
        "automotive accessory", "lifestyle accessory", "aftermarket accessories",
        "suv accessory", "toyota accessory",
    ],
    "performance parts": [
        "aftermarket upgrade", "toyota aftermarket parts", "off-road parts",
        "trd components",
    ],
    "suspension": [
        "suspension detail", "coil spring", "coilover spring", "coilover detail",
        "shock absorber", "fox shock absorber", "red coil spring", "red spring",
        "red spring detail", "trd suspension", "4x4 suspension",
    ],
    "infotainment screen": [
        "touchscreen infotainment", "infotainment system", "infotainment display",
        "touchscreen", "touchscreen display", "touchscreen dashboard",
        "dashboard touchscreen", "large touchscreen", "large touchscreen display",
        "touchscreen control",
    ],
    "navigation": [
        "navigation map", "navigation screen", "navigation display",
        "navigation map display", "touchscreen navigation", "google maps navigation",
    ],
    "cargo area": [
        "cargo space", "interior cargo area", "rear cargo area",
        "maximum cargo space", "expanded cargo space", "sedan cargo space",
        "trunk", "trunk interior", "trunk storage", "spacious trunk",
        "hatchback trunk",
    ],
    "trunk open": ["open trunk", "rear hatch open", "hatchback open"],
    "tailgate open": ["open tailgate", "tailgate down"],
    "loading cargo": [
        "man loading cargo", "woman loading cargo", "man loading gear",
        "loading gear", "man loading truck", "man loading car", "woman loading car",
        "man loading trunk", "trunk loading", "man loading cooler",
        "two people loading", "couple loading", "worker loading cargo",
        "grocery loading", "loading", "truck bed loading",
    ],
    "luggage": [
        "loading luggage", "couple with luggage", "couple loading luggage",
        "luggage loading", "luggage packed", "silver hard-shell luggage",
        "blue suitcases", "duffel bag",
    ],
    "roof rack": [
        "roof rack with bikes", "roof rack with skis", "roof rack cargo",
        "roof rack detail", "kayak on roof rack", "roof-mounted kayak",
    ],
    "roof box": ["roof cargo box"],
    "towing": [
        "towing trailer", "towing boat", "suv towing trailer",
        "horse trailer towing", "boat trailer", "boat on trailer",
        "jet ski trailer", "atv on trailer",
    ],
    "daytime": ["daylight", "bright daylight", "outdoor daylight", "natural daylight", "outdoor daytime"],
    "sunny": ["sunny day", "sunny daylight", "sunny daytime", "sunny morning", "bright sunlight", "sunlight"],
    "overcast": ["overcast sky", "cloudy sky", "overcast daylight"],
    "foggy": ["fog", "fog atmosphere", "misty atmosphere"],
    "rainy": ["heavy rain", "rain drops"],
    "wet pavement": ["wet surface", "wet", "wet surface reflections"],
    "snowy": ["snow", "snowy setting", "snowy environment", "snowy landscape"],
    "snow-capped mountains": ["snow-capped peaks", "snowy peaks"],
    "winter": ["winter landscape", "winter outdoor", "sunny winter day"],
    "autumn": ["autumn foliage", "fall foliage", "autumn setting", "autumn landscape", "autumn forest", "fallen leaves"],
    "urban": ["urban setting", "urban background", "urban backdrop", "city", "city setting"],
    "city street": ["urban street", "urban city street", "city street background"],
    "city skyline": [
        "urban skyline", "city skyline background", "urban skyline background",
        "cityscape background", "urban cityscape", "distant cityscape",
        "night cityscape",
    ],
    "skyscrapers": ["urban skyscrapers"],
    "suburban": ["suburban setting", "suburban neighborhood", "residential neighborhood", "residential"],
    "driveway": ["residential driveway", "parked driveway", "modern home driveway"],
    "parking lot": ["outdoor parking lot", "outdoor parking area", "outdoor parking", "urban parking lot", "parking"],
    "parking garage": ["parking structure"],
    "rooftop parking": ["rooftop parking lot", "rooftop parking garage"],
    "bridge": ["city bridge", "cable-stayed bridge", "cable bridge", "urban bridge"],
    "underpass": ["urban underpass"],
    "highway": ["urban highway", "city highway", "highway driving", "highway interchange"],
    "cobblestone": ["cobblestone plaza", "cobblestone sidewalk"],
    "forest": ["forest backdrop", "forest background", "forest setting", "daytime forest background"],
    "forest road": ["forest dirt road", "forest highway", "forest trail"],
    "mountain backdrop": [
        "mountains background", "mountain setting", "mountain scenery",
        "mountain view", "mountains", "mountain", "mountains in distance",
        "mountain horizon", "mountain landscape", "alpine landscape", "alpine scenery",
    ],
    "desert": [
        "desert landscape", "desert terrain", "desert background", "desert backdrop",
        "desert setting", "desert scrubland", "arid landscape", "arid terrain",
        "desert southwest", "southwest landscape", "southwest usa", "desert flats",
        "desert hills",
    ],
    "desert highway": ["desert road", "desert mountain road"],
    "canyon": ["canyon landscape", "canyon backdrop", "canyon background", "canyon vista"],
    "red rock canyon": ["red rock terrain", "red rock landscape", "red rock mountains", "red rock formations"],
    "rocky terrain": ["rocky landscape", "rocky ground"],
    "dirt road": ["dirt path", "dirt trail"],
    "coastal": ["coastline", "coastal scenery", "coastal background", "oceanside", "coastal city"],
    "ocean backdrop": ["ocean view", "ocean views"],
    "beach": ["beach backdrop"],
    "lakeside": ["lake backdrop", "lake", "lakeside setting", "urban lakeside"],
    "riverside": ["riverbank", "river"],
    "sand dunes": ["desert sand dunes"],
    "salt flats": ["salt flat"],
    "joshua trees": ["joshua tree", "joshua tree landscape"],
    "redwood forest": ["redwood trees"],
    "wilderness": ["mountain wilderness", "wilderness lifestyle"],
    "overlook": [
        "mountain overlook", "scenic overlook", "canyon overlook",
        "hilltop overlook", "hillside overlook", "overlook viewpoint",
        "urban overlook", "dirt road overlook", "coastal overlook",
        "elevated overlook",
    ],
    "camping": [
        "adventure camping", "family camping", "forest camping", "outdoor camping",
        "night camping", "couple camping", "camping setting", "camping trip",
    ],
    "campsite": ["forest campsite", "lakeside campsite"],
    "camping gear": ["camping equipment"],
    "overlanding": ["overland", "overland setup", "overland build", "overlanding equipment"],
    "adventure": [
        "outdoor adventure", "adventure lifestyle", "rugged adventure",
        "casual outdoor adventure", "rugged outdoor adventure", "adventure outdoor",
        "casual adventure", "adventure travel", "adventure ready", "adventure activity",
    ],
    "active lifestyle": ["active outdoor", "outdoor lifestyle", "outdoor recreation"],
    "rugged": ["rugged lifestyle", "rugged outdoor"],
    "family": [
        "family lifestyle", "family activity", "family travel",
        "family with children", "multigenerational family", "multiple generations",
    ],
    "off-road": ["off-road driving", "off-road capable", "off-road ready"],
    "racetrack": ["racetrack setting"],
    "dust": ["dust cloud", "dust trail", "dust spray", "dirt and dust"],
    "mud": ["muddy terrain", "mud splash", "mud splatter", "mud splashing", "muddy trail"],
    "dashboard": [
        "dashboard detail", "dashboard view", "dashboard close-up",
        "dashboard display", "modern dashboard", "toyota dashboard",
        "hybrid dashboard", "dashboard controls",
    ],
    "steering wheel": ["steering wheel detail", "steering wheel close-up"],
    "paddle shifters": ["paddle shifter", "steering wheel paddle shifter", "steering wheel paddle", "manual paddle"],
    "instrument cluster": ["digital instrument cluster"],
    "gear shifter": ["gear shift", "gear selector", "rotary dial shifter"],
    "drive mode controls": ["drive mode selector", "drive mode button"],
    "push button start": ["push to start", "push button ignition", "engine start stop button", "start button"],
    "climate controls": [
        "climate control", "climate control panel", "dual climate control",
        "dual zone climate", "auto climate", "rear climate controls",
    ],
    "air vents": ["climate vents", "dashboard vent"],
    "heated seats": [
        "heated seat button", "heated seats controls", "heated seat controls",
        "heated seat buttons", "heated rear seats", "heated and ventilated seats",
    ],
    "wireless charging": ["wireless charging pad", "smartphone charging", "dual phone charging"],
    "usb ports": ["usb port", "usb-c ports", "usb-c port", "usb-c charging port"],
    "ev charging": [
        "electric vehicle charging", "ev charging station", "ev charging cable",
        "home charging", "charging", "charging cable", "charging port",
        "ev charger plug", "blue charging connector", "blue connector",
        "man charging car", "hands on charger", "hand holding charger",
        "person plugging in",
    ],
    "electric vehicle": ["toyota electric vehicle"],
    "hybrid": ["hybrid vehicle", "toyota hybrid", "hybrid drivetrain", "hybrid awd"],
    "head-up display": ["heads-up display"],
    "surround view camera": ["surround view monitor", "multi-camera view"],
    "blind spot warning": ["blind spot indicator", "blind spot monitor"],
    "safety feature": ["safety technology"],
    "technology": [
        "modern technology", "technology focus", "technology feature",
        "technology detail shot", "technology detail", "tech detail shot",
        "technology feature callout",
    ],
    "jbl audio": ["jbl speaker", "jbl audio system", "jbl bluetooth speaker", "jbl headphones"],
    "premium audio": ["luxury audio", "audio system", "automotive audio", "high-end audio system"],
    "panoramic sunroof": ["panoramic roof", "black panoramic roof", "glass roof"],
    "leather seats": [
        "leather seat", "leather seating", "leather upholstery", "stitched leather",
        "leather interior", "premium leather seats", "premium leather",
    ],
    "tan leather seats": ["tan leather", "tan leather seat", "tan leather upholstery", "tan leather interior"],
    "black leather seats": ["black leather", "black leather seat", "black leather interior"],
    "red leather seats": ["red leather", "red leather interior", "red leather upholstery", "crimson upholstery"],
    "brown leather seats": ["brown leather", "brown leather interior"],
    "cream leather seats": ["cream leather"],
    "white leather seats": ["white leather"],
    "beige leather seats": ["beige upholstery"],
    "perforated leather": ["perforated leather seats", "perforated leather seat", "perforated seats", "perforated upholstery"],
    "two-tone upholstery": ["two-tone interior", "two-tone seating", "two-tone material"],
    "folded seats": [
        "seats folded flat", "folded rear seats", "flat fold seats",
        "flat-folded rear seats", "folding rear seats", "folded seat",
    ],
    "rear seat": ["rear seats", "back seat", "backseat", "rear seat view", "rear seat interior"],
    "third row seating": ["three-row seating"],
    "center console": ["center armrest"],
    "armrest": ["armrest detail", "armrest close-up", "armrest storage"],
    "door panel": ["door panel detail", "car door panel"],
    "front grille": [
        "front grille detail", "front grille close-up", "front grille closeup",
        "bold grille detail", "grille detail",
    ],
    "side mirror": ["side mirror detail"],
    "rearview mirror": ["rearview mirror reflection"],
    "badge": [
        "badge close-up", "badge closeup", "badge detail", "badge detail shot",
        "rear badge", "rear badge close-up", "automotive badge", "emblem",
        "chrome emblem", "toyota badge", "lexus badge", "toyota logo", "lexus logo",
        "toyota branding", "lexus branding", "steering wheel badge", "center cap logo",
    ],
    "gr badge": ["gr badging"],
    "toyota gr": ["gr toyota"],
    "trd": ["toyota trd", "trd trim"],
    "trd pro": ["toyota trd pro"],
    "pickup truck": ["truck", "toyota truck"],
    "truck bed": ["truck bed loaded"],
    "sedan": ["midsize sedan", "modern sedan"],
    "minivan": ["minivan or suv"],
    "headlight detail": ["headlight close-up", "headlight closeup", "headlight"],
    "led headlights": ["led headlight"],
    "taillight detail": ["taillight close-up", "tail light close-up", "taillight closeup", "tail light"],
    "red taillights": ["red taillight", "red tail lights"],
    "led taillights": ["led tail light"],
    "brake caliper": ["brake caliper detail", "brake caliper visible", "performance braking system"],
    "engine bay": ["under hood"],
    "undercarriage": ["undercarriage view", "undercarriage visible", "underbody close-up"],
    "detail shot": ["close-up detail shot", "close-up detail", "automotive detail shot", "automotive close-up", "close-up"],
    "exterior detail": ["exterior detail shot", "exterior close-up", "close-up exterior"],
    "interior detail": ["interior detail shot", "interior close-up"],
    "interior": ["interior shot"],
    "exterior rear": [
        "exterior rear view", "rear exterior", "rear view", "rear three-quarter view",
        "exterior rear three-quarter", "three-quarter rear view", "rear quarter view",
        "suv rear view", "rear exterior detail", "rear detail shot", "rear detail",
    ],
    "exterior front": [
        "exterior front view", "front view", "front exterior",
        "exterior front detail", "front end detail", "front detail shot",
    ],
    "aerial view": [
        "overhead shot", "overhead angle", "overhead view", "aerial perspective",
        "overhead aerial view", "bird's eye view", "bird's eye perspective",
        "overhead drone shot", "high angle shot", "aerial rear view",
    ],
    "low angle": ["low angle shot", "dramatic low angle"],
    "driver pov": ["driver's perspective", "driver perspective", "driver's seat perspective"],
    "motion blur": ["dynamic motion blur", "cinematic motion blur"],
    "action shot": ["dynamic action", "dynamic"],
    "silhouette": ["silhouette figure", "silhouette figures", "people silhouettes", "couple silhouette"],
    "pedestrians": ["pedestrian", "pedestrian background", "pedestrian legs"],
    "no people": ["no people in car"],
    "people in background": ["person in background"],
    "hands": ["hands visible", "hands detail", "hand detail", "hands only", "driver hand visible"],
    "hands on screen": ["hand pointing at screen", "hands pointing", "hand interacting"],
    "smartphone": ["hand holding phone"],
    "racing driver": ["race driver"],
    "racing helmet": ["motorsport helmet", "helmet"],
    "speedometer": ["speedometer close-up", "32 mph speedometer", "65 mph speedometer"],
    "studio": [
        "studio lighting", "studio setting", "clean studio lighting", "clean studio",
        "studio shot", "studio quality", "studio feel", "clean studio feel",
        "studio-style", "clean studio-style",
    ],
    "product shot": ["product photography"],
    "golden hour": ["golden hour light", "golden hour backlight", "golden light"],
    "dusk": ["dusk sky", "dusk lighting", "twilight", "evening"],
    "starry sky": ["starry night sky"],
    "dramatic lighting": ["dramatic light", "atmospheric lighting"],
    "dramatic sky": ["dramatic clouds", "overcast dramatic sky"],
    "warm tones": [
        "warm light", "warm lighting", "warm mood", "bright warm tones",
        "warm and inviting", "warm and cheerful", "warm glow",
    ],
    "ambient lighting": ["warm ambient lighting", "warm ambient light", "mood lighting"],
    "blue ambient lighting": ["ambient blue lighting"],
    "red ambient lighting": ["red ambient light"],
    "natural light": ["bright natural light", "clean natural light", "warm natural light", "daytime natural light"],
    "clean": [
        "clean aesthetic", "clean modern", "clean and modern", "clean modern design",
        "clean modern aesthetic", "clean tones", "clean bright tones",
        "bright and clean", "clean bright light", "clean automotive", "clean and upscale",
    ],
    "minimalist": ["clean minimal", "clean minimalist", "minimalist setting", "minimalist background", "clean minimal background"],
    "cinematic": ["clean cinematic", "cinematic lifestyle"],
    "light trails": ["cinematic light trails"],
    # color spelling: grey -> gray
    "gray car": ["grey car"],
    "gray suv": ["grey suv"],
    "gray vehicle": ["grey vehicle"],
    "gray minivan": ["grey minivan"],
    "dark gray car": ["dark grey car"],
    "dark gray truck": ["dark grey truck"],
    "dark gray": ["dark grey"],
    "silver": ["silver grey"],
    # lexus model name variants
    "lexus lc": ["lexus lc500"],
    "lexus es": ["lexus es350h", "lexus es 350h", "lexus es350e", "lexus es 350e"],
    "lexus is": ["lexus is 350"],
    "lexus ux": ["lexus ux300h"],
}


def build_lookup():
    lookup = {}
    for canonical, variants in MERGES.items():
        for v in variants:
            if v in lookup and lookup[v] != canonical:
                sys.exit(f"CONFIG ERROR: '{v}' mapped to both '{lookup[v]}' and '{canonical}'")
            if v in MERGES:
                sys.exit(f"CONFIG ERROR: '{v}' is both a variant and a canonical name")
            lookup[v] = canonical
    return lookup


def plural_merges(vocab_counts, lookup):
    """Merge trivial singular/plural pairs (e.g. 'sports cars' -> 'sports car')
    when both exist and neither is already covered by the curated map."""
    auto = {}
    for kw in list(vocab_counts):
        if not kw.endswith("s") or len(kw) < 4:
            continue
        singular = kw[:-1]
        if singular not in vocab_counts:
            continue
        if kw in lookup or kw in MERGES or singular in lookup or singular in MERGES:
            continue
        # keep the more frequent form; tie goes to the singular
        if vocab_counts[kw] > vocab_counts[singular]:
            auto[singular] = kw
        else:
            auto[kw] = singular
    return auto


def run(dry_run: bool = False):
    lookup = build_lookup()

    BACKUP_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")

    for brand, manifest_path in MANIFESTS.items():
        manifest = json.loads(manifest_path.read_text())

        vocab = {}
        for entry in manifest.values():
            for kw in entry.get("keywords", []):
                k = kw.strip().lower()
                if k:
                    vocab[k] = vocab.get(k, 0) + 1

        auto = plural_merges(vocab, lookup)
        merged_counts = {}
        changed_entries = 0

        for entry in manifest.values():
            kws = entry.get("keywords")
            if not kws:
                continue
            new = []
            seen = set()
            touched = False
            for kw in kws:
                k = kw.strip().lower()
                if not k:
                    touched = True
                    continue
                target = lookup.get(k) or auto.get(k) or k
                if target != kw:
                    touched = True
                if target != k:
                    merged_counts[f"{k} -> {target}"] = merged_counts.get(f"{k} -> {target}", 0) + 1
                if target not in seen:
                    seen.add(target)
                    new.append(target)
                else:
                    touched = True
            if touched:
                entry["keywords"] = new
                changed_entries += 1

        after_vocab = set()
        for entry in manifest.values():
            after_vocab.update(entry.get("keywords", []))

        print(f"--- {brand}")
        print(f"    distinct keywords: {len(vocab)} -> {len(after_vocab)}")
        print(f"    images touched:    {changed_entries}")
        if merged_counts:
            top = sorted(merged_counts.items(), key=lambda x: -x[1])[:12]
            for pair, n in top:
                print(f"      {n:3}x  {pair}")
            if len(merged_counts) > 12:
                print(f"      … and {len(merged_counts) - 12} more merges")

        if dry_run:
            print("    (dry run — nothing written)")
        elif changed_entries == 0:
            print("    (already condensed — nothing written)")
        else:
            backup = BACKUP_DIR / f"manifest-{brand}-{stamp}.json"
            backup.write_text(manifest_path.read_text())
            manifest_path.write_text(json.dumps(manifest, indent=2))
            print(f"    backup: {backup.relative_to(BASE_DIR)}")


def main():
    run(dry_run="--dry-run" in sys.argv)


if __name__ == "__main__":
    main()
