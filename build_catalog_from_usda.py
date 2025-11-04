#!/usr/bin/env python3
# build_catalog_from_usda.py — QUICK MODE + caching + pasta dry→cooked + safe fallbacks + pinned overrides

import json, os, sys, time, random, requests
from requests.exceptions import HTTPError, ReadTimeout, ConnectionError
from urllib3.util.retry import Retry
from requests.adapters import HTTPAdapter

API_KEY   = os.environ.get("FDC_API_KEY") or "NuhSiWOGwnfXb7cNTTGYsGfHAtK0lyKi7WQ3sz3y"
SEED      = "catalog.seed.json"
OUT       = "catalog.json"
CACHE     = "usda_cache.json"
API_BASE  = "https://api.nal.usda.gov/fdc/v1"
QUICK_MODE= ("--quick" in sys.argv) or (os.environ.get("QUICK") == "1")

# ---------- precise search hints (helps stubborn items land on correct cooked entries) ----------
NAME_HINTS = {
    # proteins (cooked)
    "chicken_breast_cooked":      "chicken breast, cooked, grilled",
    "ground_turkey_93_cooked":    "turkey, ground, 93% lean, cooked, crumbles",
    "ground_beef_93_cooked":      "beef, ground, 93% lean meat / 7% fat, cooked, crumbles",
    "top_sirloin_cooked":         "beef top sirloin steak, cooked, grilled",
    "salmon_cooked":              "salmon, atlantic, farmed, cooked, dry heat",
    "shrimp_cooked":              "shrimp, cooked",
    "cod_cooked":                 "cod, cooked, baked, dry heat",
    "ground_chicken_cooked":      "chicken, ground, cooked, crumbles",

    # grains/starches (cooked; “without salt” aligns with SR/Legacy entries)
    "brown_rice_cooked":          "rice, brown, long-grain, cooked, without salt",
    "jasmine_rice_cooked":        "rice, white, jasmine, cooked, without salt",
    "quinoa_cooked":              "quinoa, cooked",
    "farro_cooked":               "farro (emmer), cooked",

    # pasta (USDA mostly lists branded pasta DRY → we convert to cooked)
    "barilla_protein_plus_pasta_cooked": "Barilla Protein+ pasta",
    "chickpea_pasta_cooked":             "pasta, chickpea",

    # vegetables (cooked)
    "zucchini_cooked":            "zucchini, cooked, boiled, drained, without salt",
    "spinach_cooked":             "spinach, cooked, boiled, drained, without salt",

    # dairy/nondairy
    "nonfat_greek_yogurt":        "yogurt, greek, nonfat, plain",
    "unsweetened_almond_milk":    "almond milk, unsweetened",
    "light_string_cheese":        "cheese, mozzarella, low moisture, part-skim, string",
    "part_skim_mozzarella":       "cheese, mozzarella, part-skim, low moisture",

    # bread
    "gluten_free_bread":          "bread, gluten-free"
}

# ---------- safe per-100g fallbacks (used only if match is implausible; never leave zeros) ----------
SAFE_FALLBACKS = {
    "ground_turkey_93_cooked":   {"kcal": 170.0, "protein": 22.0},
    "salmon_cooked":             {"kcal": 184.0, "protein": 29.0},
    "farro_cooked":              {"kcal": 125.0, "protein": 4.5},
    "gluten_free_bread":         {"kcal": 240.0, "protein": 5.0},
    "zucchini_cooked":           {"kcal": 17.0,  "protein": 1.2},
    "spinach_cooked":            {"kcal": 23.0,  "protein": 2.9},
    "nonfat_greek_yogurt":       {"kcal": 59.0,  "protein": 10.0},
    "unsweetened_almond_milk":   {"kcal": 15.0,  "protein": 0.6},
    "light_string_cheese":       {"kcal": 215.0, "protein": 25.0},
    "part_skim_mozzarella":      {"kcal": 280.0, "protein": 24.0},
    "brown_rice_cooked":         {"kcal": 123.0, "protein": 2.6},
    "jasmine_rice_cooked":       {"kcal": 130.0, "protein": 2.4},
    "quinoa_cooked":             {"kcal": 120.0, "protein": 4.4},
    "barilla_protein_plus_pasta_cooked": {"kcal": 155.0, "protein": 10.0},
    "chickpea_pasta_cooked":     {"kcal": 155.0, "protein": 9.0}
}

# ---------- pinned overrides (force-correct known cooked values every run) ----------
PINNED_OVERRIDES = {
    # veggies
    "zucchini_cooked": {"kcal": 17.0, "protein": 1.2},
    # proteins
    "salmon_cooked": {"kcal": 184.0, "protein": 29.0},
    # optional cooked pasta correction for brand consistency
    "barilla_protein_plus_pasta_cooked": {"kcal": 155.0, "protein": 10.0},
}

# ---------- caching ----------
def load_cache():
    if not os.path.exists(CACHE):
        return {"food_by_id":{}, "search":{}}
    try:
        with open(CACHE,"r") as f:
            return json.load(f)
    except Exception:
        return {"food_by_id":{}, "search":{}}

def save_cache(cache):
    with open(CACHE,"w") as f:
        json.dump(cache, f, indent=2)

CACHE_DB = load_cache()

# ---------- HTTP session (fast in QUICK mode) ----------
def build_session():
    if QUICK_MODE:
        retry = Retry(total=3, connect=2, read=2, backoff_factor=0.5,
                      status_forcelist=(429,500,502,503,504),
                      allowed_methods=frozenset(["GET"]), raise_on_status=False)
        timeouts = (5, 15)
        sleep_min, sleep_span = 0.06, 0.04
    else:
        retry = Retry(total=6, connect=4, read=4, backoff_factor=0.8,
                      status_forcelist=(429,500,502,503,504),
                      allowed_methods=frozenset(["GET"]), raise_on_status=False)
        timeouts = (10, 60)
        sleep_min, sleep_span = 0.18, 0.10
    s = requests.Session()
    s.mount("https://", HTTPAdapter(max_retries=retry))
    s.mount("http://",  HTTPAdapter(max_retries=retry))
    s._timeouts = timeouts
    s._sleep_min = sleep_min
    s._sleep_span = sleep_span
    return s

SESSION = build_session()

def _sleep():
    time.sleep(SESSION._sleep_min + random.uniform(0, SESSION._sleep_span))

def _get(url, **params):
    params = {"api_key": API_KEY, **params}
    tries, delay = 0, 0.5 if QUICK_MODE else 0.75
    while True:
        try:
            r = SESSION.get(url, params=params, timeout=SESSION._timeouts)
            r.raise_for_status()
            return r.json()
        except (ReadTimeout, ConnectionError, HTTPError):
            tries += 1
            if tries >= (3 if QUICK_MODE else 5):
                raise
            time.sleep(delay + random.uniform(0, 0.25))
            delay *= 1.6

# ---------- USDA helpers with cache ----------
def fetch_by_id(fdc_id):
    key = str(fdc_id)
    if key in CACHE_DB["food_by_id"]:
        return CACHE_DB["food_by_id"][key]
    data = _get(f"{API_BASE}/food/{fdc_id}")
    CACHE_DB["food_by_id"][key] = data
    return data

def search_by_name(name, datasets, page_size=30):
    cache_key = f"{name}||{'|'.join(datasets)}||{page_size}"
    if cache_key in CACHE_DB["search"]:
        return CACHE_DB["search"][cache_key]
    all_foods = []
    for dt in datasets:
        try:
            res = _get(f"{API_BASE}/foods/search", query=name, dataType=dt, pageSize=page_size)
            all_foods.extend(res.get("foods", []) or [])
        except HTTPError:
            continue
    CACHE_DB["search"][cache_key] = all_foods
    return all_foods

# ---------- nutrient extraction ----------
def per100_from_food(food):
    kcal = None; protein = None
    for n in food.get("foodNutrients", []):
        num  = n.get("nutrient",{}).get("number") or n.get("nutrientNumber")
        unit = (n.get("nutrient",{}).get("unitName") or "").lower()
        amt  = n.get("amount")
        if amt is None: continue
        if str(num) == "1008" and unit in ("kcal","kcals"): kcal = amt
        if str(num) == "1003" and unit == "g":              protein = amt
    if kcal is None or protein is None:
        for n in food.get("foodNutrients", []):
            nm   = (n.get("nutrient",{}).get("name") or "").lower()
            unit = (n.get("nutrient",{}).get("unitName") or "").lower()
            amt  = n.get("amount")
            if amt is None: continue
            if kcal is None and "energy" in nm and unit in ("kcal","kcals"): kcal = amt
            if protein is None and "protein" in nm and unit == "g":          protein = amt
    return kcal, protein

# ---------- plausibility ----------
def plausible(group, kcal, protein, desc=""):
    if kcal is None or protein is None: return False
    k, p = float(kcal), float(protein)
    if group == "lean_proteins":         return 90 <= k <= 260 and p >= 18
    if group == "whole_grains_starches": return 60 <= k <= 190 and 1 <= p <= 12
    if group == "breads":                return 180 <= k <= 340 and 3 <= p <= 18
    if group == "green_vegetables":      return 10  <= k <= 80  and 0.3 <= p <= 7
    if group == "dairy_nondairy":        return 15  <= k <= 350 and 0   <= p <= 30   # widened for cheese/yogurt
    return k > 0 and p >= 0

def prefer_order(name, group):
    branded_words = ["barilla","dave","killer bread","ezekiel","fairlife","almond"]
    low = name.lower()
    if group in ("lean_proteins","whole_grains_starches","green_vegetables"):
        return ["Foundation","SR Legacy","Survey (FNDDS)","Branded"]
    if any(w in low for w in branded_words) or group in ("breads","dairy_nondairy"):
        return ["Branded","Foundation","SR Legacy","Survey (FNDDS)"]
    return ["Foundation","SR Legacy","Survey (FNDDS)","Branded"]

def is_branded_pasta_dry(food):
    desc  = (food.get("description","") or "").lower()
    owner = (food.get("brandOwner","") or "").lower()
    dry_flags = ["dry","uncooked","unprepared"]
    looks_dry = any(flag in desc for flag in dry_flags)
    looks_brand = "barilla" in owner or "barilla" in desc
    kcal, _ = per100_from_food(food)
    high_kcal = (kcal or 0) >= 280
    return looks_brand and (looks_dry or high_kcal)

def convert_dry_pasta_per100_to_cooked(kcal, protein, yield_factor=2.22):
    if kcal is None or protein is None: return kcal, protein
    return float(kcal)/yield_factor, float(protein)/yield_factor

def pick_best_by_group(candidates, group, fallback_name):
    def score(food):
        kcal, pro = per100_from_food(food)
        ok = plausible(group, kcal, pro, food.get("description",""))
        hay = (food.get("description","") + " " + (food.get("brandOwner","") or "")).lower()
        match = 2 if fallback_name.lower() in hay else 0
        return (1 if ok else 0, match, float(food.get("score",0.0)))
    candidates.sort(key=score, reverse=True)
    return candidates[0] if candidates else None

# ---------- resume helpers ----------
def load_existing_catalog():
    if not os.path.exists(OUT): return {}
    try:
        with open(OUT,"r") as f: data = json.load(f)
        return data.get("ingredients", {})
    except Exception:
        return {}

def already_good(entry, group):
    try:
        per100 = entry.get("per100", {})
        return plausible(group, per100.get("kcal"), per100.get("protein"))
    except Exception:
        return False

def cookedify_query(group, name, is_branded_like=False):
    low = name.lower()
    if is_branded_like or group in ("breads","dairy_nondairy"): return name
    if group in ("lean_proteins","whole_grains_starches") and "cooked" not in low:
        return name + " cooked"
    return name

# ---------- main ----------
def main():
    mode = "QUICK" if QUICK_MODE else "NORMAL"
    print(f"Running USDA builder in {mode} mode…")
    if API_KEY == "REPLACE_WITH_YOUR_KEY":
        print("[ERROR] Add your USDA API key (set FDC_API_KEY or edit the script)."); sys.exit(1)

    with open(SEED,"r") as f:
        seed = json.load(f)

    existing = load_existing_catalog()
    ingredients_out = {}; swapGroups = {}
    count_skip=count_ok=count_warn=0

    for group, items in seed.items():
        swapGroups.setdefault(group, [])
        for it in items:
            key, display_name = it["key"], it["name"]
            desired_fdcId = str(it.get("fdcId") or "").strip() or None

            # Fast path: keep plausible existing values (speeds up rebuilds)
            if key in existing and already_good(existing[key], group):
                ingredients_out[key] = existing[key]
                swapGroups[group].append(key)
                count_skip += 1
                print(f"[SKIP] {key} already plausible")
                continue

            food = None; fdcId = desired_fdcId

            # 0) direct by FDC ID (cached)
            if fdcId:
                try:
                    food = fetch_by_id(fdcId)
                    kcal, pro = per100_from_food(food)
                    if not plausible(group, kcal, pro): food=None
                except Exception:
                    food=None

            # brand routing
            branded_like = any(w in display_name.lower() for w in ("barilla","dave","ezekiel","fairlife","almond"))

            # 1) search — NORMAL mode does a deeper pass; QUICK does a minimal pass
            base_q = NAME_HINTS.get(key) or display_name
            q1 = cookedify_query(group, base_q, branded_like)
            datasets = prefer_order(display_name, group)
            if QUICK_MODE:
                cand = search_by_name(q1, ["Foundation","SR Legacy","Branded"], page_size=12)
            else:
                cand = search_by_name(q1, datasets, page_size=30)
            best = pick_best_by_group(cand, group, display_name)
            if best:
                try:
                    fdcId = str(best.get("fdcId"))
                    food  = fetch_by_id(fdcId)
                except Exception:
                    food = None

            # nutrients
            kcal, protein = per100_from_food(food) if food else (None, None)

            # special-case: branded dry pasta → convert to cooked if needed
            if food and group == "whole_grains_starches" and "pasta" in display_name.lower():
                owner = (food.get("brandOwner","") or "").lower()
                if "barilla" in owner or "barilla" in (food.get("description","") or "").lower():
                    kc0, pr0 = kcal, protein
                    if (protein or 0) < 8 or (kcal or 0) >= 270:
                        kcal, protein = convert_dry_pasta_per100_to_cooked(kcal, protein)
                    # sanity after conversion
                    if not (120 <= (kcal or 0) <= 190 and 5 <= (protein or 0) <= 12):
                        kcal, protein = kc0, pr0

            # accept or fallback
            if not plausible(group, kcal, protein):
                fb = SAFE_FALLBACKS.get(key)
                if fb:
                    kcal, protein = fb["kcal"], fb["protein"]
                    tag = "QUICK-FB" if QUICK_MODE else "FALLBACK"
                    print(f"[{tag}] {key} → per100 {{'kcal': {kcal}, 'protein': {protein}}}")
                else:
                    print(f"[WARN] {key} unresolved → zeros")
                    count_warn += 1
                    kcal = kcal or 0; protein = protein or 0
            else:
                print(f"[OK] {key} → FDC {fdcId} | {{'kcal': {round(float(kcal),2)}, 'protein': {round(float(protein),2)}}}")
                count_ok += 1

            # ----- PINNED OVERRIDES (always applied last) -----
            if key in PINNED_OVERRIDES:
                ovr = PINNED_OVERRIDES[key]
                kcal = ovr["kcal"]; protein = ovr["protein"]
                print(f"[PIN] {key} forced override → per100 {{'kcal': {kcal}, 'protein': {protein}}}")

            # write item
            ingredients_out[key] = {
                "name": display_name,
                "fdcId": fdcId or "",
                "per100": {"kcal": round(float(kcal or 0),2), "protein": round(float(protein or 0),2)},
                "conversions": {},
                "tags": []
            }
            swapGroups[group].append(key)
            _sleep()

    # write outputs + cache
    with open(OUT,"w") as f:
        json.dump({"ingredients":ingredients_out,"swapGroups":swapGroups}, f, indent=2)
    save_cache(CACHE_DB)

    total = count_ok + count_warn + count_skip
    print("\n===== USDA BUILD SUMMARY =====")
    print(f"Mode:          {mode}")
    print(f"Total items:   {total}")
    print(f"OK:            {count_ok}")
    print(f"Warnings(0s):  {count_warn}")
    print(f"Skipped(plausible): {count_skip}")
    print(f"Cache file:    {CACHE}")

if __name__ == "__main__":
    main()
