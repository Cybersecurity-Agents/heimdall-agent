// Real OpenVPN handshake and console lifecycle, using a temporary local CA/lab.
// No external VPN credentials or registry access required.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const image = process.argv[2];
if (!image) throw new Error('Usage: node scripts/build/smoke-vpn.mjs IMAGE');
const prefix = `heimdall-vpn-smoke-${process.pid}-${Date.now()}`;
const desk = `${prefix}-desk`, peer = `${prefix}-peer`, volume = `${prefix}-data`;
const files = mkdtempSync(join(tmpdir(), 'heimdall-vpn-pki-'));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const api = (path, body) => JSON.parse(execFileSync('docker', ['exec', '-i', desk, 'node', '-e', `
let body='';process.stdin.on('data',x=>body+=x);process.stdin.on('end',async()=>{
 const r=await fetch('http://127.0.0.1:8700${path}', body ? {method:'POST',headers:{'Content-Type':'application/json'},body}:{});
 console.log(await r.text()); if(!r.ok) process.exitCode=1;
});`], { input: body ? JSON.stringify(body) : '', encoding: 'utf8', timeout: 20_000, stdio: ['pipe','pipe','pipe'] }));
const until = async (check, description) => {
  for (let i=0;i<60;i++) { try { if(check()) return; } catch {} await sleep(500); }
  throw new Error(`Timed out: ${description}`);
};
const startDesk = () => docker('run', '-d', '--name', desk, '--network', prefix, '--init', '--cap-add=NET_ADMIN', '--device=/dev/net/tun', '--mount', `type=volume,src=${volume},dst=/opt/heimdall/data`, image);
try {
  // Generate throwaway certificates inside the image; never reuse operator credentials.
  docker('run', '--rm', '--network', 'none', '--mount', `type=bind,src=${files},dst=/pki`, '--entrypoint', 'bash', image, '-ec', `
cd /pki
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 1 -subj /CN=Heimdall-Smoke-CA
for role in server client; do
  openssl req -newkey rsa:2048 -nodes -keyout "$role.key" -out "$role.csr" -subj "/CN=$role"
  printf 'keyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=%sAuth\n' "$role" > "$role.ext"
  openssl x509 -req -in "$role.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -out "$role.crt" -days 1 -extfile "$role.ext"
done
chmod 644 ca.crt client.crt client.key
`);
  const profile = `client\ndev tun\nproto udp\nremote ${peer} 1194\nnobind\nremote-cert-tls server\n<ca>\n${readFileSync(join(files,'ca.crt'),'utf8')}</ca>\n<cert>\n${readFileSync(join(files,'client.crt'),'utf8')}</cert>\n<key>\n${readFileSync(join(files,'client.key'),'utf8')}</key>\n`;
  writeFileSync(join(files,'server.conf'), 'dev tun\nproto udp\nport 1194\nserver 10.239.87.0 255.255.255.0\ntopology subnet\nca /pki/ca.crt\ncert /pki/server.crt\nkey /pki/server.key\ndh none\nkeepalive 2 10\nverb 3\n');
  docker('network','create','--internal',prefix);
  docker('volume','create',volume);
  docker('run','-d','--name',peer,'--network',prefix,'--cap-add=NET_ADMIN','--device=/dev/net/tun','--mount',`type=bind,src=${files},dst=/pki,readonly`,'--entrypoint','openvpn',image,'--config','/pki/server.conf');
  await until(()=>docker('logs',peer).includes('Initialization Sequence Completed'),'local VPN server');
  startDesk();
  await until(()=>api('/health').ok,'console startup');
  assert.equal(api('/api/vpn').mode,'embedded');
  assert.equal(api('/api/vpn').running,false);
  api('/api/vpn',{content:profile,connect:true});
  await until(()=>api('/api/vpn').ready,'first handshake');
  assert.match(docker('exec',desk,'ip','-br','address','show','tun0'),/10\.239\.87\./);
  docker('exec',desk,'ping','-c','1','-W','2','10.239.87.1');
  const pid = docker('exec',desk,'pgrep','-x','openvpn');
  api('/api/vpn',{connect:true});
  await until(()=>api('/api/vpn').ready,'reconnect');
  assert.notEqual(docker('exec',desk,'pgrep','-x','openvpn'),pid);
  api('/api/vpn',{action:'disconnect'});
  assert.equal(api('/api/vpn').running,false);
  assert.doesNotMatch(docker('exec',desk,'ip','-br','link'),/tun0/);
  docker('stop','-t','15',desk); docker('rm',desk); startDesk();
  await until(()=>api('/health').ok,'disconnected recreation');
  assert.equal(api('/api/vpn').running,false);
  api('/api/vpn',{connect:true});
  await until(()=>api('/api/vpn').ready,'connect before recreation');
  docker('stop','-t','15',desk); docker('rm',desk); startDesk();
  await until(()=>api('/api/vpn').ready,'automatic connection restore');
  api('/api/vpn',{action:'disconnect'});
  api('/api/vpn',{content:profile.replace(`remote ${peer} 1194`,'remote 127.0.0.1 9'),connect:true});
  api('/api/vpn',{action:'disconnect'});
  assert.equal(api('/api/vpn').running,false);
  assert.equal(api('/api/vpn').connecting,false);
  console.log('VPN smoke passed: real TLS handshake, task network, reconnect, disconnect, recreation preferences, cancellation.');
} catch (error) {
  try { console.error('VPN peer log:', docker('logs', '--tail', '30', peer)); } catch {}
  try { console.error('VPN client log:', docker('exec', desk, 'tail', '-30', '/opt/heimdall/data/logs/openvpn.log')); } catch {}
  throw error;
} finally {
  for(const name of [desk,peer]) { try { docker('rm','-f',name); } catch {} }
  try { docker('volume','rm',volume); } catch {}
  try { docker('network','rm',prefix); } catch {}
  // Root-owned temporary keys are removed inside the same image.
  try { docker('run','--rm','--network','none','--mount',`type=bind,src=${files},dst=/pki`,'--entrypoint','sh',image,'-c','rm -f /pki/*'); } catch {}
  rmSync(files,{recursive:true,force:true});
}
