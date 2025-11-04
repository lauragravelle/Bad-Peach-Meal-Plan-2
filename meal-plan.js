// meal-plan.js (module)
import { scaleRecipeForPaths_FixedProtein } from './scaler-fixed-protein.js';

/* ========== DOM helpers ========== */
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

/* ========== State ========== */
let RECIPES = [];

/* ========== Load recipes.json ========== */
async function loadRecipes(){
  try {
    const res = await fetch('./recipes.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}: Could not load recipes.json`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('recipes.json must be an array of recipe objects.');
    RECIPES = data;
    renderRecipes(RECIPES);
  } catch (err) {
    console.error('Error loading recipes.json:', err);
    alert(`Failed to load recipes.\n${err.message}\n\nTip: Run via Live Server (http://), not file://`);
  }
}

/* ========== Meal type mapping & UI lists ========== */
function mealType(r) {
  const t = (r.meal_type || r.category || '').toString().trim().toLowerCase();
  if (t === 'breakfast') return 'Breakfast';
  if (t === 'snack' || t === 'snacks') return 'Snack';
  if (t === 'dinner') return 'Dinner';
  return '';
}

function renderRecipes(recipes){
  const buckets = { Breakfast: $('#breakfastList'), Snack: $('#snackList'), Dinner: $('#dinnerList') };
  Object.values(buckets).forEach(el => el && (el.innerHTML = ''));
  const totals = { Breakfast: 0, Snack: 0, Dinner: 0 };

  for (const r of recipes) {
    const type = mealType(r);
    const mount = buckets[type];
    if (!mount) continue;
    totals[type]++;

    const wrap = document.createElement('label');
    wrap.className = 'recipe-item';
    wrap.innerHTML = `
      <input type="checkbox" name="recipe" value="${r.id}" data-name="${r.name}" aria-label="Choose ${r.name}">
      <span class="recipe-title">${r.name}</span>
    `;
    mount.appendChild(wrap);
  }

  const bTot = $('[data-total="breakfast"]');
  const sTot = $('[data-total="snack"]');
  const dTot = $('[data-total="dinner"]');
  if (bTot) bTot.textContent = totals.Breakfast || 0;
  if (sTot) sTot.textContent = totals.Snack     || 0;
  if (dTot) dTot.textContent = totals.Dinner    || 0;

  updateCounters();
}

/* ========== Selection counters / validation ========== */
function desiredCounts(){
  const meals = $('#mealsPerDay')?.value || '4';
  return {
    Breakfast:+($('#breakfastRotation')?.value || 3),
    Snack: meals==='3' ? 0 : +($('#snackRotation')?.value || 2),
    Dinner:+($('#dinnerRotation')?.value || 3)
  };
}
function currentCounts(){
  const counts = {Breakfast:0, Snack:0, Dinner:0};
  $$('.recipe-item input[name="recipe"]:checked').forEach(cb=>{
    const parent = cb.closest('#breakfastList, #snackList, #dinnerList');
    const parentId = parent?.id || '';
    if(parentId==='breakfastList') counts.Breakfast++;
    else if(parentId==='snackList') counts.Snack++;
    else if(parentId==='dinnerList') counts.Dinner++;
  });
  return counts;
}
function applyChip(id, want, have){
  const el = $(id);
  if (!el) return;
  el.textContent = `Select ${want}`;
  const exact = have===want;
  el.classList.remove('ok','warn');
  el.classList.add(exact ? 'ok' : 'warn');
  el.setAttribute('title', exact ? 'Selection complete' : `Selected ${have} (need ${want})`);
}
function updateCounters(){
  const want = desiredCounts();
  const have = currentCounts();
  applyChip('#breakfastCounter', want.Breakfast, have.Breakfast);
  applyChip('#snackCounter',     want.Snack,     have.Snack);
  applyChip('#dinnerCounter',    want.Dinner,    have.Dinner);

  const three = ($('#mealsPerDay')?.value || '4') === '3';
  const list  = $('#snackList');
  const note  = $('#snackNote');
  if(three){
    list?.classList.add('disabled');
    if (note) note.textContent='3 meals/day selected — do not choose snacks.';
    list?.querySelectorAll('input').forEach(cb=>cb.checked=false);
  } else {
    list?.classList.remove('disabled');
    if (note) note.textContent='If 3 meals/day, skip snacks.';
  }
}
document.addEventListener('change', (e)=>{
  if(e.target && (e.target.matches('#breakfastRotation') || e.target.matches('#snackRotation') || e.target.matches('#dinnerRotation') || e.target.matches('#mealsPerDay'))){
    updateCounters();
  }
  if(e.target && e.target.matches('.recipe-item input[name="recipe"]')){
    updateCounters();
  }
});

/* ========== Inputs -> per-meal targets ========== */
function computeTargetsFromUI() {
  const TDEE = Number($('#calories')?.value || 0);
  const proteinDaily = Number($('#protein')?.value || 0);
  const meals = Number($('#mealsPerDay')?.value || 4);

  const fatLossDaily     = Math.round(TDEE * 0.85);
  const maintenanceDaily = Math.round(TDEE);
  const muscleGainDaily  = Math.round(TDEE * 1.15);

  return {
    mealsPerDay: meals,
    proteinPerMeal: proteinDaily / meals,   // evenly split
    caloriesPerMeal: {
      fatLoss:     fatLossDaily / meals,
      maintenance: maintenanceDaily / meals,
      muscleGain:  muscleGainDaily / meals
    },
    topLine: { tdee: TDEE, protein: proteinDaily }
  };
}
function getSelectedRecipeIDs() {
  return $$('.recipe-item input[name="recipe"]:checked').map(cb => cb.value);
}

/* ========== Scale helpers ========== */
function splitByType(recipes){
  const B=[], S=[], D=[];
  recipes.forEach(r=>{
    const t = (r.meal_type||'').toLowerCase();
    if(t==='breakfast') B.push(r);
    else if(t==='snack' || t==='snacks') S.push(r);
    else if(t==='dinner') D.push(r);
  });
  return {B,S,D};
}

/* RESULTS PAGE: meals labeled properly */
function buildWeeklyPlanFromScaled(scaledRecipes, mealsPerDay, activePath, proteinPerMeal){
  const {B,S,D} = splitByType(scaledRecipes);
  const plan = [];
  for(let day=0; day<7; day++){
    const meals = [];
    if(B.length){
      const r = B[day % B.length];
      const v = r.variants?.[activePath];
      if (v && v.scaled_serving) {
        meals.push({
          name:`Breakfast — ${r.name}`,
          meal_type:'breakfast',
          calories_kcal:v.scaled_serving.calories_kcal,
          protein_g: proteinPerMeal
        });
      }
    }
    if(D.length){
      const rLunch = D[(day+6)%D.length];
      const vL = rLunch.variants?.[activePath];
      if (vL && vL.scaled_serving) {
        meals.push({
          name:`Lunch — leftovers from previous day's dinner`,
          meal_type:'lunch',
          calories_kcal:vL.scaled_serving.calories_kcal,
          protein_g: proteinPerMeal
        });
      }
    }
    if(String(mealsPerDay)==='4' && S.length){
      const rS = S[day % S.length];
      const vS = rS.variants?.[activePath];
      if (vS && vS.scaled_serving) {
        meals.push({
          name:`Snack — ${rS.name}`,
          meal_type:'snack',
          calories_kcal:vS.scaled_serving.calories_kcal,
          protein_g: proteinPerMeal
        });
      }
    }
    if(D.length){
      const rD = D[day % D.length];
      const vD = rD.variants?.[activePath];
      if (vD && vD.scaled_serving) {
        meals.push({
          name:`Dinner — ${rD.name}`,
          meal_type:'dinner',
          calories_kcal:vD.scaled_serving.calories_kcal,
          protein_g: proteinPerMeal
        });
      }
    }
    plan.push({ day: day+1, meals });
  }
  return plan;
}

/* ========== Generate & persist ========== */
async function onGenerate(){
  const selectedIDs = getSelectedRecipeIDs();
  if (!selectedIDs.length){ alert('Please select at least one recipe.'); return; }
  const targets = computeTargetsFromUI();

  // Keep full base recipes for results-page scaling (NO UI change)
  const selectedBase = RECIPES
    .filter(r => selectedIDs.includes(r.id))
    .map(r => ({
      id: r.id,
      name: r.name,
      meal_type: r.meal_type,
      instructions: r.instructions || "",
      // keep originals for accurate path scaling
      ingredients: Array.isArray(r.ingredients) ? r.ingredients.map(x=>({...x})) : []
    }));

  // Also maintain your previous structure for compatibility
  const selected = selectedBase.map(r => ({ ...r }));

  // Build variants per path using the fixed-protein scaler
  const scaled = selected.map(r => {
    const base = Array.isArray(r.ingredients) ? r.ingredients : [];
    const variants = {
      fatLoss:     scaleRecipeForPaths_FixedProtein(r, base, targets.proteinPerMeal, targets.caloriesPerMeal.fatLoss),
      maintenance: scaleRecipeForPaths_FixedProtein(r, base, targets.proteinPerMeal, targets.caloriesPerMeal.maintenance),
      muscleGain:  scaleRecipeForPaths_FixedProtein(r, base, targets.proteinPerMeal, targets.caloriesPerMeal.muscleGain)
    };
    // Keep a maintenance macro line in the top-level ingredients for legacy readers
    const vMaint = variants.maintenance?.scaled_serving || {calories_kcal:0, protein_g:0};
    return {
      id:r.id, name:r.name, meal_type:r.meal_type, instructions:r.instructions||"",
      ingredients:[{calories_kcal:vMaint.calories_kcal, protein_g:vMaint.protein_g}],
      variants
    };
  });

  function makePath(pathKey){
    const days = buildWeeklyPlanFromScaled(scaled, targets.mealsPerDay, pathKey, targets.proteinPerMeal);

    // Keep previous grocery behavior (list of names)
    const groups={MEAT:new Set(),SEAFOOD:new Set(),DAIRY:new Set(),PRODUCE:new Set(),GRAINS:new Set(),SPICES:new Set(),OTHER:new Set()};
    scaled.forEach(r=>{
      (r.ingredients||[]).forEach(i=>{
        const nm = (i.name || i.ingredient || '').trim();
        if(!nm) return;
        const name = nm;
        if(/chicken|turkey|beef|steak/i.test(name))groups.MEAT.add(name);
        else if(/salmon|shrimp|fish/i.test(name))groups.SEAFOOD.add(name);
        else if(/yogurt|cheese|milk|egg|cottage/i.test(name))groups.DAIRY.add(name);
        else if(/spinach|kale|pepper|tomato|berry|banana|avocado|onion|lime|lemon|cilantro|lettuce/i.test(name))groups.PRODUCE.add(name);
        else if(/rice|quinoa|oats|bread|pasta/i.test(name))groups.GRAINS.add(name);
        else if(/salt|pepper|spice|season|paprika|cumin|oregano|garlic/i.test(name))groups.SPICES.add(name);
        else groups.OTHER.add(name);
      });
    });
    const grocery={}; Object.keys(groups).forEach(k=>{grocery[k]=Array.from(groups[k]).sort();});
    const recipesSlim = scaled.map(r=>{
      const v = r.variants[pathKey]?.scaled_serving || {calories_kcal:0, protein_g:0};
      return { name:r.name, ingredients:[{calories_kcal:v.calories_kcal, protein_g:v.protein_g}], instructions:r.instructions };
    });

    return {days,recipes:recipesSlim,grocery,grocery_list:Object.values(grocery).flat()};
  }

  // Build per-path bundles
  const fatloss = makePath('fatLoss');
  const maint   = makePath('maintenance');
  const muscle  = makePath('muscleGain');

  // --- Session storage: write BOTH new and legacy keys so results.html can read them ---
  const userParams = {
    tdee: targets.topLine.tdee,
    protein: targets.topLine.protein,
    mealsPerDay: targets.mealsPerDay
  };

  // BASE_RECIPES (NEW) — full selected recipes for safe ingredient scaling on results.html
  sessionStorage.setItem('BASE_RECIPES', JSON.stringify(selectedBase));

  // Your newer keys
  sessionStorage.setItem('SCALED_RECIPES', JSON.stringify({ fatloss, maint, muscle }));
  sessionStorage.setItem('USER_TARGETS', JSON.stringify(userParams));
  sessionStorage.setItem('ACTIVE_PATH','fatLoss');

  // Legacy/compat keys
  sessionStorage.setItem('bp_user_params', JSON.stringify(userParams));
  sessionStorage.setItem('bp_active_path','fatLoss');
  sessionStorage.setItem('bp_scaled', JSON.stringify({
    fatLoss: fatloss, maintenance: maint, muscleGain: muscle
  }));
  sessionStorage.setItem('bp_weekly_fatloss', JSON.stringify(fatloss.days));
  sessionStorage.setItem('bp_weekly_maintenance', JSON.stringify(maint.days));
  sessionStorage.setItem('bp_weekly_musclegain', JSON.stringify(muscle.days));

  location.href='./results.html';
}

/* ========== DOM Ready ========== */
document.addEventListener('DOMContentLoaded', ()=>{
  $('#generateBtn')?.addEventListener('click', onGenerate);
  $('#generateBtnMobile')?.addEventListener('click', onGenerate);
  loadRecipes();
});

export { buildWeeklyPlanFromScaled };
// (Any grocery helper functions you had before can live below)
