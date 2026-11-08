import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { InputError } from './domain.js';

const run = promisify(execFile);
const CLASSES = ['no-damage', 'minor-damage', 'major-damage', 'destroyed'];
const limitations = ['Historical Hurricane Harvey 2017 imagery is separate from the fictional family exercise.', 'Known building-footprint crops only; no ground photos or autonomous building detection.', 'Scores are uncalibrated estimates, not personal safety, road access or shelter suitability.', 'Single-event, tile-disjoint evaluation does not establish unseen-disaster performance.'];
const jsonFile = (path) => JSON.parse(readFileSync(path, 'utf8'));
export class SatelliteService {
  constructor(root, executor = run) { this.root = root; this.executor = executor; this.running = false; }
  load() {
    const activePath = resolve(this.root, '.data/model-active.json');
    if (!existsSync(activePath)) return null;
    const active = jsonFile(activePath);
    if (!/^[a-f0-9]{64}$/.test(active.modelSha256)) throw new InputError('Invalid local model metadata.', 503);
    const dir = resolve(this.root, '.data/models', active.modelSha256);
    const index = jsonFile(resolve(dir, 'app_index.json'));
    const config = jsonFile(resolve(dir, 'model_config.json'));
    const metrics = jsonFile(resolve(dir, 'metrics.json'));
    const verification = jsonFile(resolve(dir, 'local-verification.json'));
    const attribution = jsonFile(resolve(dir, 'attribution.json'));
    return { active, dir, index, config, metrics, verification, attribution };
  }
  status() {
    try {
      const data = this.load();
      if (!data) return { available:false, reason:'Trained model not imported yet.', tiles:[], liveInferenceAvailable:false, limitations };
      const { active,index,config,metrics,verification,attribution } = data;
      return { available:true, model:{sha256:active.modelSha256,architecture:config.architecture,bestEpoch:metrics.best_epoch}, metrics:{macroF1:metrics.test.macro_f1,majorityMacroF1:metrics.majority_baseline_test.macro_f1,accuracy:metrics.test.accuracy,perClass:metrics.test.per_class}, tiles:index.tiles.map(({preFile,postFile,...tile})=>({...tile,preImageUrl:`/api/satellite/images/${encodeURIComponent(preFile.split('/').at(-1))}`,postImageUrl:`/api/satellite/images/${encodeURIComponent(postFile.split('/').at(-1))}`})), attribution, liveInferenceAvailable:verification.verified === true && verification.modelSha256===active.modelSha256 && existsSync(resolve(this.root,'.venv/bin/python')), localVerification:verification, limitations };
    } catch { return { available:false,reason:'Local model bundle could not be validated. Re-import the verified bundle.',tiles:[],liveInferenceAvailable:false,limitations }; }
  }
  image(name) {
    const data = this.load();
    if (!data || !/^[a-zA-Z0-9_-]+\.png$/.test(name)) throw new InputError('Satellite image not found.',404);
    const file = data.index.tiles.flatMap(t=>[t.preFile,t.postFile]).find(f=>f.split('/').at(-1)===name);
    if (!file || !/^demo_images\/[a-zA-Z0-9_-]+\.png$/.test(file)) throw new InputError('Satellite image not found.',404);
    return readFileSync(resolve(data.dir,file));
  }
  async infer(input) {
    const status = this.status();
    if (!status.liveInferenceAvailable) throw new InputError('Verified local inference is not available yet.',409);
    if (!input || Object.keys(input).some(k=>!['tileId','buildingId'].includes(k))) throw new InputError('Choose a bundled tile and building only.');
    const data = this.load();
    const tile = data.index.tiles.find(t=>t.id===input.tileId);
    const building = tile?.buildings.find(b=>b.id===input.buildingId);
    if (!building) throw new InputError('Bundled building not found.',404);
    if (this.running) throw new InputError('One local inference is already running. Try again when it finishes.',409);
    if (createHash('sha256').update(readFileSync(resolve(data.dir,'best.pt'))).digest('hex')!==data.active.modelSha256) throw new InputError('Model checksum changed. Re-import the verified bundle.',409);
    this.running=true;
    const start=performance.now();
    try {
      const { stdout } = await this.executor(resolve(this.root,'.venv/bin/python'), [resolve(this.root,'training/infer_xbd.py'),'--model-dir',data.dir,'--data-root',data.dir,'--pre-image',tile.preFile,'--post-image',tile.postFile,'--box',...building.box.map(String)], { timeout:90_000,maxBuffer:64*1024,env:{PATH:process.env.PATH,HOME:process.env.HOME,OMP_NUM_THREADS:'2',MKL_NUM_THREADS:'2',PYTHONDONTWRITEBYTECODE:'1'} });
      const output=JSON.parse(stdout);
      if (output.state !== 'estimated' || output.source !== 'custom_model' || output.calibrated !== false || output.model_sha256!==data.active.modelSha256 || !CLASSES.includes(output.damage_class) || CLASSES.some(c=>!Number.isFinite(output.probabilities?.[c]) || output.probabilities[c]<0 || output.probabilities[c]>1) || Math.abs(CLASSES.reduce((sum,c)=>sum+output.probabilities[c],0)-1)>0.001) throw new Error('Invalid prediction');
      if (CLASSES.reduce((best,c)=>output.probabilities[c]>output.probabilities[best]?c:best,CLASSES[0]) !== output.damage_class) throw new Error('Prediction class mismatch');
      return {prediction:{damageClass:output.damage_class,probabilities:output.probabilities,source:'local_model_inference',state:'estimated',modelSha256:output.model_sha256,computedAt:new Date().toISOString(),durationMs:Math.round(performance.now()-start)}};
    } catch { throw new InputError('Local inference failed. Cached estimates remain available; no family status changed.',503); }
    finally { this.running=false; }
  }
}
