"""PPO for the war minds, with a league of earlier generations.

    python3 ml/rl/ppo.py --run realpolitik [--iters 500] [--gen-every 10] [--futures 56]

Rollouts run in Node (ml/rl/rollout.ts, every core); this file only learns, on
the GPU if there is one. The network mirrors src/ml/warNet.ts exactly, and
checkpoints are flat float32 files that warNet.ts loads as is.

Every --gen-every iterations the learner is frozen as the next generation:
ckpt/gen_XXX.bin. Generation k is what polities fight with from year k * 10000 / N
in the browser, so a future gets wiser at war as it goes.
"""
import argparse, json, os, subprocess, sys, time
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as Fn

DS, DP, H1, H2, HQ, NPOST, NPAIR = 32, 22, 128, 64, 64, 4, 8
SLICES = {1: (0, 2), 2: (2, 4), 3: (4, 8)}
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class WarNet(nn.Module):
    """Same layers, same order as warNet.ts LAYERS."""
    def __init__(self):
        super().__init__()
        self.l1, self.l2 = nn.Linear(DS, H1), nn.Linear(H1, H2)
        self.v, self.post = nn.Linear(H2, 1), nn.Linear(H2, NPOST)
        self.q1, self.q2 = nn.Linear(H2 + DP, HQ), nn.Linear(HQ, NPAIR)

    def layers(self):
        return [self.l1, self.l2, self.v, self.post, self.q1, self.q2]

    def trunk(self, s):
        return torch.tanh(self.l2(torch.tanh(self.l1(s))))

    def pair(self, h, p):
        return self.q2(torch.tanh(self.q1(torch.cat([h, p], -1))))

    def flat(self):
        return np.concatenate([np.concatenate([l.weight.detach().cpu().numpy().ravel(), l.bias.detach().cpu().numpy().ravel()]) for l in self.layers()]).astype(np.float32)

    def load_flat(self, x):
        k = 0
        for l in self.layers():
            nw, nb = l.weight.numel(), l.bias.numel()
            l.weight.data.copy_(torch.from_numpy(x[k:k + nw].reshape(l.weight.shape))); k += nw
            l.bias.data.copy_(torch.from_numpy(x[k:k + nb])); k += nb
        assert k == len(x)


def gen0(seed):
    """Generation zero: random, but biased toward today's rule-based rates (war is rare, peace is the default)."""
    torch.manual_seed(seed)
    net = WarNet()
    with torch.no_grad():
        net.post.bias.copy_(torch.tensor([0.0, 1.5, 0.0, -1.0]))
        net.q2.bias.copy_(torch.tensor([0.0, -6.5, 0.0, -7.0, 1.0, 0.0, 0.0, 0.0]))
        net.q2.weight.mul_(0.3); net.post.weight.mul_(0.3)
    return net


def read_batch(path):
    b = open(path, 'rb').read()
    nA, nD, ds, dp = np.frombuffer(b, np.int32, 4)
    assert (ds, dp) == (DS, DP)
    o = 16
    def take(dt, n):
        nonlocal o
        a = np.frombuffer(b, dt, n, o); o += a.nbytes; return a
    pad = lambda n: (4 - n % 4) % 4
    B = {}
    B['self'] = take(np.float32, nA * DS).reshape(nA, DS)
    B['reward'] = take(np.float32, nA); B['nxt'] = take(np.int32, nA)
    B['pAct'] = take(np.uint8, nA); o += pad(nA)
    B['pLogp'] = take(np.float32, nA)
    B['dAgent'] = take(np.int32, nD)
    B['dKind'] = take(np.uint8, nD); B['dAct'] = take(np.uint8, nD); B['dMask'] = take(np.uint8, nD); o += pad(3 * nD)
    B['dLogp'] = take(np.float32, nD); B['dPair'] = take(np.float32, nD * DP).reshape(nD, DP)
    assert o == len(b), (o, len(b))
    return B


def pair_logp(net, h, B_kind, B_pair, B_act, B_mask):
    """log prob and entropy of each pair decision under its head (terms masked to what was allowed)."""
    logits = net.pair(h, B_pair)
    lp = torch.zeros(len(B_kind), device=h.device); ent = torch.zeros_like(lp)
    for kind, (lo, hi) in SLICES.items():
        m = B_kind == kind
        if not m.any(): continue
        lg = logits[m, lo:hi]
        if kind == 3:
            allowed = ((B_mask[m].unsqueeze(1) >> torch.arange(4, device=h.device)) & 1).bool()
            lg = lg.masked_fill(~allowed, -1e9)
        ls = Fn.log_softmax(lg, -1)
        lp[m] = ls.gather(1, B_act[m].long().unsqueeze(1)).squeeze(1)
        ent[m] = -(ls.exp() * ls).sum(-1)
    return lp, ent


class Rollouts:
    def __init__(self):
        env = dict(os.environ)
        self.p = subprocess.Popen(['node', '--experimental-strip-types', '--no-warnings', os.path.join(ROOT, 'ml/rl/rollout.ts')],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, cwd=ROOT, env=env, text=True)

    def run(self, **cmd):
        self.p.stdin.write(json.dumps(cmd) + '\n'); self.p.stdin.flush()
        line = self.p.stdout.readline()
        if not line: raise RuntimeError('rollout server died')
        return json.loads(line)


def way_of_war(stats):
    """Averages over futures: the numbers the chronicle and the player see."""
    n = max(1, len(stats))
    tot = lambda k: sum(s[k] for s in stats)
    wars = tot('wars')
    return {
        'wars': wars / n, 'kinetic': tot('kinetic') / n,
        'killedPerWar': tot('killed') / max(1, wars), 'meanDur': sum(s['meanDur'] * s['wars'] for s in stats) / max(1, wars),
        'annexShare': tot('annex') / max(1, wars), 'repShare': tot('rep') / max(1, wars), 'roundsPerWar': tot('rounds') / max(1, wars),
        'finalPop': sum(s['pop'] for s in stats) / n,
        'warsByMillennium': [sum(s['byK'][k] for s in stats) / n for k in range(10)],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--run', default='realpolitik')
    ap.add_argument('--iters', type=int, default=500)
    ap.add_argument('--gen-every', type=int, default=10)
    ap.add_argument('--futures', type=int, default=56)
    ap.add_argument('--eval-futures', type=int, default=28)
    ap.add_argument('--league-share', type=float, default=0.3)
    ap.add_argument('--lr', type=float, default=3e-4)
    ap.add_argument('--gamma', type=float, default=0.99)
    ap.add_argument('--lam', type=float, default=0.95)
    ap.add_argument('--clip', type=float, default=0.2)
    ap.add_argument('--epochs', type=int, default=4)
    ap.add_argument('--minibatch', type=int, default=16384)
    ap.add_argument('--ent', type=float, default=0.01)
    ap.add_argument('--seed', type=int, default=1)
    a = ap.parse_args()

    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    run = os.path.join(ROOT, 'ml/rl/runs', a.run); ck = os.path.join(run, 'ckpt'); os.makedirs(ck, exist_ok=True)
    shm = '/dev/shm' if os.path.isdir('/dev/shm') else run
    log = open(os.path.join(run, 'log.jsonl'), 'a')
    def emit(**kv):
        kv['t'] = time.time(); log.write(json.dumps(kv) + '\n'); log.flush()
        print(json.dumps({k: (round(v, 4) if isinstance(v, float) else v) for k, v in kv.items() if k != 'warsByMillennium'}), flush=True)

    net = gen0(a.seed).to(dev)
    gens = sorted(f for f in os.listdir(ck) if f.startswith('gen_'))
    start = 0
    if os.path.exists(os.path.join(ck, 'learner.bin')):           # resume
        net.load_flat(np.fromfile(os.path.join(ck, 'learner.bin'), np.float32)); net.to(dev)
        start = json.load(open(os.path.join(ck, 'state.json')))['iter']
    if not gens:
        net.flat().tofile(os.path.join(ck, 'gen_000.bin')); gens = ['gen_000.bin']
    opt = torch.optim.Adam(net.parameters(), lr=a.lr, eps=1e-5)
    ret_std = 1.0
    R = Rollouts()
    eval_seeds = list(range(1, a.eval_futures + 1))     # held out: training seeds start at 1,000,000

    def evaluate(gen_file, it):
        r = R.run(seeds=eval_seeds, learner=os.path.join(ck, gen_file), league=[], leagueShare=0, record=False)
        emit(kind='eval', iter=it, gen=gen_file, **way_of_war(r['stats']))

    if start == 0: evaluate('gen_000.bin', 0)
    for it in range(start, a.iters):
        t0 = time.time()
        lp = os.path.join(shm, f'{a.run}_learner.bin'); net.flat().tofile(lp)
        league = [os.path.join(ck, g) for g in gens[-8:]]
        seeds = [1_000_000 + it * a.futures + k for k in range(a.futures)]
        out = os.path.join(shm, f'{a.run}_batch.bin')
        r = R.run(seeds=seeds, learner=lp, league=league, leagueShare=a.league_share, out=out, record=True)
        t1 = time.time()
        B = read_batch(out)
        nA = len(B['reward'])
        T = lambda x, dt=torch.float32: torch.as_tensor(np.array(x), dtype=dt, device=dev)
        S, rew, nxt = T(B['self']), B['reward'].astype(np.float64), B['nxt']
        pAct, pLogp = T(B['pAct'], torch.long), T(B['pLogp'])
        dAg, dKind, dAct, dMask = T(B['dAgent'], torch.long), T(B['dKind'], torch.long), T(B['dAct'], torch.long), T(B['dMask'], torch.long)
        dLogp, dPair = T(B['dLogp']), T(B['dPair'])
        old_lp = pLogp.clone().index_add_(0, dAg, dLogp)
        with torch.no_grad():
            V = net.v(net.trunk(S)).squeeze(1).cpu().numpy().astype(np.float64)
        # GAE backwards: each agent step's successor is later in the batch
        r_n = rew / ret_std
        adv = np.zeros(nA); ret = np.zeros(nA)
        for i in range(nA - 1, -1, -1):
            j = nxt[i]
            vn, an = (V[j], adv[j]) if j >= 0 else (0.0, 0.0)
            d = r_n[i] + a.gamma * vn - V[i]
            adv[i] = d + a.gamma * a.lam * an
            ret[i] = adv[i] + V[i]
        ret_std = 0.9 * ret_std + 0.1 * max(1e-3, float(np.std(ret * ret_std)))
        A = T((adv - adv.mean()) / (adv.std() + 1e-8)); RET = T(ret)
        # pair decisions grouped by agent step for minibatching
        order = torch.argsort(dAg); dAg, dKind, dAct, dMask, dLogp, dPair = dAg[order], dKind[order], dAct[order], dMask[order], dLogp[order], dPair[order]
        stats = []
        for _ in range(a.epochs):
            perm = torch.randperm(nA, device=dev)
            for k in range(0, nA, a.minibatch):
                mb = perm[k:k + a.minibatch]
                inmb = torch.zeros(nA, dtype=torch.bool, device=dev); inmb[mb] = True
                remap = torch.full((nA,), -1, dtype=torch.long, device=dev); remap[mb] = torch.arange(len(mb), device=dev)
                dm = inmb[dAg]
                h = net.trunk(S[mb])
                post = Fn.log_softmax(net.post(h), -1)
                lp_new = post.gather(1, pAct[mb].unsqueeze(1)).squeeze(1)
                ent = -(post.exp() * post).sum(-1)
                if dm.any():
                    di = remap[dAg[dm]]
                    plp, pent = pair_logp(net, h[di], dKind[dm], dPair[dm], dAct[dm], dMask[dm])
                    lp_new = lp_new.index_add(0, di, plp)
                    ent = ent.index_add(0, di, pent)
                ratio = torch.exp(lp_new - old_lp[mb])
                pg = -torch.min(ratio * A[mb], torch.clamp(ratio, 1 - a.clip, 1 + a.clip) * A[mb]).mean()
                vl = 0.5 * (net.v(h).squeeze(1) - RET[mb]).pow(2).mean()
                loss = pg + 0.5 * vl - a.ent * ent.mean()
                opt.zero_grad(); loss.backward(); nn.utils.clip_grad_norm_(net.parameters(), 0.5); opt.step()
                with torch.no_grad():
                    stats.append([pg.item(), vl.item(), ent.mean().item(), ((ratio - 1).abs() > a.clip).float().mean().item()])
        s = np.mean(stats, 0)
        pact = np.bincount(B['pAct'], minlength=4) / max(1, nA)
        press = B['dKind'] == 1; strike = B['dKind'] == 2; terms = B['dKind'] == 3
        emit(kind='train', iter=it + 1, rolloutS=t1 - t0, learnS=time.time() - t1, agents=nA, decisions=len(B['dKind']),
             reward=float(rew.mean()), pg=s[0], vloss=s[1], entropy=s[2], clipFrac=s[3],
             posture=pact.round(3).tolist(), pressWar=float(B['dAct'][press].mean()) if press.any() else 0,
             strikeLaunch=float(B['dAct'][strike].mean()) if strike.any() else 0,
             terms=(np.bincount(B['dAct'][terms], minlength=4) / max(1, terms.sum())).round(3).tolist(),
             **{k: v for k, v in way_of_war(r['stats']).items() if k != 'warsByMillennium'})
        net.flat().tofile(os.path.join(ck, 'learner.bin'))
        json.dump({'iter': it + 1}, open(os.path.join(ck, 'state.json'), 'w'))
        if (it + 1) % a.gen_every == 0:
            g = f'gen_{len(gens):03d}.bin'
            net.flat().tofile(os.path.join(ck, g)); gens.append(g)
            evaluate(g, it + 1)


if __name__ == '__main__':
    main()
