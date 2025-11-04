/* scaler-fixed-protein.js
   Fixed-protein scaling with per-meal calorie target + post-rounding nudge.
   Safe to import in any environment (no top-level return).
*/

/* ---------- tiny utils ---------- */
function sum(arr, fn) { return arr.reduce((a, x) => a + (fn ? fn(x) : x), 0); }
function cloneDeep(x) { return JSON.parse(JSON.stringify(x)); }

function isProtein(i){
  const name = (i?.name || i?.ingredient || '').toLowerCase();
  const tags = i?.tags || [];
  if (tags.some(t => /protein|chicken|turkey|shrimp|salmon|egg|yogurt|cottage|tofu|tempeh|edamame|whey|casein/i.test(t))) return true;
  return /protein powder|chicken|turkey|shrimp|salmon|egg|egg white|yogurt|cottage|tofu|tempeh|edamame|whey|casein/.test(name);
}
function isCarbFat(i){
  const name = (i?.name || i?.ingredient || '').toLowerCase();
  const tags = i?.tags || [];
  if (tags.some(t => /carb|grain|starch|fat|oil|cheese|nut|seed|avocado|tortilla|rice|oats|bread|olive/i.test(t))) return true;
  return /tortilla|rice|oat|bread|pasta|oil|olive|butter|cheese|avocado|nut|seed|granola|hummus|bean|black bean|quinoa|farro|brown rice/.test(name);
}
function isNonScaling(i){
  const name = (i?.name || i?.ingredient || '').toLowerCase();
  const tags = i?.tags || [];
  if (tags.some(t => /spice|season|herb|zero|free|water|ice|extract/i.test(t))) return true;
  return /salt|pepper|cinnamon|garlic powder|onion powder|paprika|cumin|vanilla extract|ice|water|zero-cal/i.test(name);
}

function computeTotals(ings){
  return {
    calories_kcal: Math.round(sum(ings, i => i.calories_kcal || 0)),
    protein_g:     Math.round(sum(ings, i => i.protein_g     || 0)*2)/2
  };
}
function roundAmount(name, unit, value){
  if (!isFinite(value)) return 0;
  if (unit === 'g') {
    const v = Math.max(0, value);
    if (v <= 20)  return Math.round(v);      // 1 g
    if (v <= 150) return Math.round(v/5)*5;  // 5 g
    return Math.round(v/10)*10;              // 10 g
  }
  if (unit === 'cups') {
    const frac = [0, 1/8, 1/6, 1/4, 1/3, 1/2, 2/3, 3/4, 1];
    const nearest = frac.reduce((a,b)=> Math.abs(b-value)<Math.abs(a-value)?b:a, 0);
    return nearest;
  }
  return value;
}
function guessGPerCup(name){
  const n = (name||'').toLowerCase();
  if (/oat|granola/.test(n)) return 80;
  if (/rice|quinoa|farro/.test(n)) return 160;
  if (/berry|fruit|cucumber|tomato|zucchini|pepper/.test(n)) return 140;
  if (/yogurt|cottage/.test(n)) return 245;
  if (/bean|chickpea|edamame/.test(n)) return 170;
  if (/cheese/.test(n)) return 120;
  if (/avocado/.test(n)) return 150;
  return 240; // generic fallback
}

/* ---------- core steps ---------- */
function scaleProteinToTarget(ings, proteinTarget){
  const out = cloneDeep(ings);
  const protItems = out.filter(isProtein);
  const others    = out.filter(i => !isProtein(i));

  const protNow = sum(protItems, i => i.protein_g || 0);
  if (protItems.length === 0 || !isFinite(proteinTarget)) return out;

  const factor  = Math.max(0, proteinTarget / Math.max(1, protNow));
  protItems.forEach(P => {
    const newG = roundAmount(P.name||P.ingredient||'', 'g', (P.amount_g||0) * factor);
    const f = newG / Math.max(1, (P.amount_g||0));
    P.amount_g      = newG;
    P.protein_g     = (P.protein_g||0) * f;
    P.calories_kcal = (P.calories_kcal||0) * f;
  });

  return protItems.concat(others).sort((a,b)=> (a._idx||0)-(b._idx||0));
}

function scaleCarbFatToCalories(ings, caloriesTarget){
  const out = cloneDeep(ings);
  const nonScaling = out.filter(isNonScaling);
  const cfItems    = out.filter(i => !isNonScaling(i));

  const kcalNow = sum(cfItems, i => i.calories_kcal || 0);
  const fixedK  = sum(nonScaling, i => i.calories_kcal || 0);
  const targetK = Math.max(0, (caloriesTarget||0) - fixedK);

  if (kcalNow <= 0 || targetK <= 0) return out;

  const factor = targetK / kcalNow;
  cfItems.forEach(i=>{
    const newG = roundAmount(i.name||i.ingredient||'', 'g', (i.amount_g||0) * factor);
    const f    = newG / Math.max(1, (i.amount_g||0));
    i.amount_g      = newG;
    i.protein_g     = (i.protein_g||0) * f;
    i.calories_kcal = (i.calories_kcal||0) * f;
    const perCup    = guessGPerCup(i.name||i.ingredient||'');
    i.amount_cups   = roundAmount(i.name||i.ingredient||'', 'cups', newG / perCup);
  });

  return cfItems.concat(nonScaling).sort((a,b)=> (a._idx||0)-(b._idx||0));
}

function finalizeRecipe(recipe, ings, caloriesTarget){
  const finalized = cloneDeep(ings);
  let totals = computeTotals(finalized);

  // small nudge to land exactly on per-meal calories after rounding
  if (isFinite(caloriesTarget)) {
    let diff = Math.round(caloriesTarget - (totals.calories_kcal || 0));
    if (Math.abs(diff) > 5) {
      let idx = finalized.findIndex(i => isCarbFat(i) && (i.calories_kcal||0) > 0 && (i.amount_g||0));
      if (idx === -1) idx = finalized.findIndex(i => (i.amount_g||0) && (i.calories_kcal||0) > 0);
      if (idx !== -1) {
        const it = finalized[idx];
        const calPerG = (it.calories_kcal||0) / Math.max(1,(it.amount_g||0));
        if (calPerG > 0) {
          const dg   = diff / calPerG;
          const newG = roundAmount(it.name||it.ingredient||'', 'g', (it.amount_g||0) + dg);
          const f    = newG / Math.max(1,(it.amount_g||0));
          it.amount_g      = newG;
          const perCup     = guessGPerCup(it.name||it.ingredient||'') || 240;
          it.amount_cups   = roundAmount(it.name||it.ingredient||'', 'cups', newG / perCup);
          it.calories_kcal = (it.calories_kcal||0) * f;
          it.protein_g     = (it.protein_g||0) * f;
          totals = computeTotals(finalized);
        }
      }
    }
  }

  return {
    recipe: { id: recipe?.id, name: recipe?.name, instructions: recipe?.instructions ?? "", base_serving: recipe?.base_serving },
    ingredients: finalized,
    totals
  };
}

/* ---------- exported API ---------- */
/**
 * @param {Object} recipe
 * @param {Array|Object} baseIngredients  Array of ingredients OR an object containing {ingredients:[...]}
 * @param {number} perMealProteinTarget
 * @param {number} perMealCalorieTarget
 */
export function scaleRecipeForPaths_FixedProtein(recipe, baseIngredients, perMealProteinTarget, perMealCalorieTarget){
  // Accept multiple shapes robustly (prevents `.map` errors)
  const rawList =
    Array.isArray(baseIngredients)                  ? baseIngredients :
    Array.isArray(baseIngredients?.ingredients)     ? baseIngredients.ingredients :
    Array.isArray(recipe?.ingredients)              ? recipe.ingredients :
    [];

  // Preserve incoming order for stable rounding & rounding drift control
  const indexed = rawList.map((i,idx)=>({ ...i, _idx: idx }));

  const step1 = scaleProteinToTarget(indexed, perMealProteinTarget);
  const step2 = scaleCarbFatToCalories(step1, perMealCalorieTarget);
  const fin   = finalizeRecipe(recipe, step2, perMealCalorieTarget);

  return {
    ...fin,
    scaled_serving: {
      calories_kcal: fin.totals.calories_kcal,
      protein_g:     fin.totals.protein_g
    }
  };
}
