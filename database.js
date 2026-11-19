'use strict';

const el = id => document.getElementById(id);
const say = (lo, zh) => currentLang === 'zh' ? zh : lo;
const preferenceKey = 'sanlian.supabase.project';
const accountDialog = el('accountDialog');
const quoteTable = 'sanlian_quotations';
let db = null;
let connection = null;
let authListener = null;
let account = null;
let catalog = [];
let reportRequest = 0;
let editingRequest = 0;

function updateAccountUI(){
  el('connectionForm').hidden = Boolean(db);
  el('loginForm').hidden = !db || Boolean(account);
  el('signedInPanel').hidden = !account;
  el('changeProjectBtn').hidden = !db || Boolean(account);
  el('accountBtn').classList.toggle('is-signed-in', Boolean(account));
  el('accountLabel').dataset.i18n = account ? 'connected' : db ? 'signIn' : 'connection';
  el('accountLabel').textContent = t(el('accountLabel').dataset.i18n);
  el('accountEmail').textContent = account?.email || '';
  el('connectionHost').textContent = connection?.url || '';
}

function authStatus(message, isError = false){
  el('authStatus').textContent = message;
  el('authStatus').style.color = isError ? 'var(--danger)' : 'var(--teal)';
}

function friendlyError(error){
  if (error.code === '42P01' || error.code === 'PGRST205') {
    return say('ກະລຸນາຕິດຕັ້ງ supabase.sql ໃນ SQL Editor', '请先在 SQL Editor 中运行 supabase.sql');
  }
  if (error.code === '23505') {
    return say('ເລກທີໃບສະເໜີນີ້ຖືກໃຊ້ແລ້ວ', '此报价单编号已存在');
  }
  return error.message || say('ການເຊື່ອມຕໍ່ຂັດຂ້ອງ', '连接失败');
}

function normalizeProject(url, key){
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(parsed.hostname) ||
      parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(say('ໃສ່ URL ໂຄງການ https://project-ref.supabase.co', '请输入 https://project-ref.supabase.co 格式的项目 URL'));
  }
  let isAnon = false;
  try {
    const part = key.split('.')[1];
    isAnon = JSON.parse(atob(part.replaceAll('-', '+').replaceAll('_', '/'))).role === 'anon';
  } catch {
    // A publishable key does not have a JWT payload.
  }
  if (!/^sb_publishable_[a-zA-Z0-9_-]+$/.test(key) && !isAnon) {
    throw new Error(say('ໃຊ້ Publishable key ຫຼື anon key', '请使用 Publishable key 或 anon key'));
  }
  return {url: parsed.origin, key};
}

function connectProject(config){
  if (!window.supabase) {
    throw new Error(say('ໂຫລດ Supabase ບໍ່ສຳເລັດ. ກວດອິນເຕີເນັດ ແລ້ວໂຫລດໜ້າໃໝ່', '无法加载 Supabase，请检查网络并刷新页面'));
  }
  db = window.supabase.createClient(config.url, config.key);
  connection = config;
  const client = db;
  authListener = client.auth.onAuthStateChange((_event, session) => {
    const priorId = account?.id;
    account = session?.user || null;
    if (priorId !== account?.id) {
      reportRequest++;
      editingRequest++;
      reportRecords = [];
      catalog = [];
      el('catalogPicker').hidden = true;
      el('catalogSelect').replaceChildren();
      if (priorId) clearQuotation(true);
      renderReportTable();
      setEditorStatus('', false);
      if (el('reportView').style.display !== 'none') {
        setTimeout(() => { if (db === client) loadReport(); }, 0);
      }
    }
    updateAccountUI();
  }).data.subscription;
  updateAccountUI();
}

function openAccount(){
  authStatus('');
  updateAccountUI();
  if (!accountDialog.open) accountDialog.showModal();
}

function currentConnection(status){
  if (db && account) return {client: db, userId: account.id};
  status(say('ກະລຸນາເຂົ້າລະບົບ Supabase ກ່ອນ', '请先登录 Supabase'), true);
  return null;
}

function stillCurrent(session){
  return db === session.client && account?.id === session.userId;
}

el('accountBtn').addEventListener('click', openAccount);
el('closeAccountBtn').addEventListener('click', () => accountDialog.close());
document.addEventListener('quotation:language', updateAccountUI);

el('connectionForm').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const config = normalizeProject(el('projectUrl').value.trim(), el('projectKey').value.trim());
    connectProject(config);
    try { localStorage.setItem(preferenceKey, JSON.stringify(config)); } catch {}
    el('projectKey').value = '';
    authStatus('');
    el('loginEmail').focus();
  } catch (error) {
    authStatus(friendlyError(error), true);
  }
});

el('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const client = db;
  if (!client) return;
  const button = event.submitter;
  button.disabled = true;
  el('changeProjectBtn').disabled = true;
  authStatus('');
  try {
    const {error} = await client.auth.signInWithPassword({
      email: el('loginEmail').value.trim(),
      password: el('loginPassword').value
    });
    if (error) throw error;
    accountDialog.close();
  } catch (error) {
    authStatus(friendlyError(error), true);
  } finally {
    el('loginPassword').value = '';
    button.disabled = false;
    el('changeProjectBtn').disabled = false;
  }
});

el('signOutBtn').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const {error} = await db.auth.signOut({scope: 'local'});
    if (error) throw error;
    authStatus('');
  } catch (error) {
    authStatus(friendlyError(error), true);
  } finally {
    button.disabled = false;
  }
});

el('changeProjectBtn').addEventListener('click', () => {
  if (account) return;
  authListener?.unsubscribe();
  db?.auth.stopAutoRefresh();
  db = null;
  connection = null;
  try { localStorage.removeItem(preferenceKey); } catch {}
  authStatus('');
  updateAccountUI();
});

function buildQuote(){
  const docNo = el('docNo').value.trim();
  const discountRate = Number(el('discountRate').value);
  if (!docNo || docNo.length > 80) {
    el('docNo').closest('details').open = true;
    el('docNo').focus();
    throw new Error(say('ໃສ່ເລກທີໃບສະເໜີ 1–80 ຕົວອັກສອນ', '请输入 1–80 个字符的报价单编号'));
  }
  if (el('discountRate').validity.badInput || discountRate < 0 || discountRate > 100) {
    el('discountRate').closest('details').open = true;
    el('discountRate').focus();
    throw new Error(say('ສ່ວນຫຼຸດຕ້ອງຢູ່ໃນລະຫວ່າງ 0–100%', '折扣必须在 0–100% 之间'));
  }
  if (![lastTotals.subtotal, lastTotals.grandTotal].every(Number.isFinite)) {
    throw new Error(say('ກວດເບິ່ງລາຄາ ແລະ ຈຳນວນ', '请检查价格与数量'));
  }
  return {
    doc_no: docNo,
    doc_date: el('docDate').value || null,
    client: el('clientName').value.trim(),
    currency: el('currencySelect').value,
    grand_total: lastTotals.grandTotal.toFixed(2),
    payload: {
      validDate: el('validDate').value,
      companyName: el('companyName').value,
      companyMeta: el('companyMeta').value,
      clientMeta: el('clientMeta').value,
      items,
      note: el('noteText').value,
      attachImages,
      discountRate,
      discount: lastTotals.discountAmt,
      subtotal: lastTotals.subtotal,
      areaUnit: el('areaUnitSelect').value
    }
  };
}

el('saveQuoteBtn').addEventListener('click', async event => {
  const session = currentConnection(setEditorStatus);
  if (!session) { openAccount(); return; }
  const button = event.currentTarget;
  const newButton = el('newQuoteBtn');
  const prior = activeRecord;
  button.disabled = true;
  newButton.disabled = true;
  setEditorStatus(say('ກຳລັງບັນທຶກ…', '正在保存…'), false);
  try {
    const row = buildQuote();
    const table = session.client.from(quoteTable);
    const query = prior
      ? table.update(row).eq('id', prior.id).eq('owner_id', session.userId).eq('updated_at', prior.updatedAt)
      : table.insert({...row, owner_id: session.userId});
    const {data, error} = await query.select('id, updated_at').maybeSingle();
    if (!stillCurrent(session)) return;
    if (error) throw error;
    if (!data) {
      throw new Error(say('ໃບສະເໜີຖືກປ່ຽນແປງແລ້ວ. ເປີດໃໝ່ຈາກໜ້າລາຍງານ', '报价单已变更，请从报表重新打开'));
    }
    activeRecord = {id: data.id, updatedAt: data.updated_at};
    setEditorStatus(say('ບັນທຶກແລ້ວ', '已保存') + ' · ' + row.doc_no, false);
    if (el('reportView').style.display !== 'none') loadReport();
  } catch (error) {
    if (stillCurrent(session)) setEditorStatus(friendlyError(error), true);
  } finally {
    button.disabled = false;
    newButton.disabled = false;
  }
});

async function loadReport(){
  const request = ++reportRequest;
  const session = currentConnection(setReportStatus);
  if (!session) return;
  const {client, userId} = session;
  setReportStatus(say('ກຳລັງໂຫລດ…', '正在加载…'), false);
  try {
    const rows = [];
    let cursor = null;
    while (stillCurrent(session) && request === reportRequest) {
      let query = client.from(quoteTable).select('id,doc_no,doc_date,client,currency,grand_total,updated_at')
        .eq('owner_id', userId).order('updated_at', {ascending:false}).order('id', {ascending:false}).limit(100);
      if (cursor) {
        query = query.or(`updated_at.lt.${cursor.updated_at},and(updated_at.eq.${cursor.updated_at},id.lt.${cursor.id})`);
      }
      const {data, error} = await query;
      if (error) throw error;
      if (!data.length) break;
      rows.push(...data);
      cursor = data.at(-1);
      if (data.length < 100) break;
    }
    if (!stillCurrent(session) || request !== reportRequest) return;
    reportRecords = rows.map(row => ({
      id: row.id, docNo: row.doc_no, date: row.doc_date, client: row.client,
      currency: row.currency, grandTotal: row.grand_total, timestamp: row.updated_at
    }));
    renderReportTable();
    setReportStatus(say(`${rows.length} ໃບສະເໜີ`, `${rows.length} 份报价单`), false);
  } catch (error) {
    if (stillCurrent(session) && request === reportRequest) setReportStatus(friendlyError(error), true);
  }
}

el('reportBody').addEventListener('click', async event => {
  const button = event.target.closest('button[data-record-id]');
  if (!button || el('saveQuoteBtn').disabled) return;
  const record = reportRecords.find(row => row.id === button.dataset.recordId);
  const session = currentConnection(setReportStatus);
  if (!record || !session) return;
  const deleting = button.classList.contains('btn-delete');
  if (deleting && !confirm(say(`ລຶບໃບສະເໜີ ${record.docNo} ຖາວອນ?`, `永久删除报价单 ${record.docNo}？`))) return;
  const request = ++editingRequest;
  button.disabled = true;
  try {
    const table = session.client.from(quoteTable);
    const result = deleting
      ? await table.delete().eq('id', record.id).eq('owner_id', session.userId)
          .eq('updated_at', record.timestamp).select('id').maybeSingle()
      : await table.select('*').eq('id', record.id).eq('owner_id', session.userId).maybeSingle();
    if (!stillCurrent(session)) return;
    if (result.error) throw result.error;
    if (!result.data) throw new Error(say('ຂໍ້ມູນຖືກປ່ຽນແລ້ວ. ໂຫລດໃໝ່', '数据已变更，请刷新'));
    const row = result.data;
    if (deleting) {
      if (activeRecord?.id === row.id) activeRecord = null;
      await loadReport();
    } else if (request === editingRequest && el('reportView').style.display !== 'none') {
      activeRecord = {id: row.id, updatedAt: row.updated_at};
      editRecord({...row.payload, docNo: row.doc_no, date: row.doc_date, client: row.client, currency: row.currency});
    }
  } catch (error) {
    if (stillCurrent(session)) setReportStatus(friendlyError(error), true);
  } finally {
    button.disabled = false;
  }
});

el('loadItemsBtn').addEventListener('click', async event => {
  const session = currentConnection(setEditorStatus);
  if (!session) { openAccount(); return; }
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const rows = [];
    while (stillCurrent(session)) {
      const from = rows.length;
      const {data, error} = await session.client.from('sanlian_catalog')
        .select('name,work_detail,width,height,size_unit,use_area,price')
        .eq('owner_id', session.userId).order('name').order('id').range(from, from + 99);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 100) break;
    }
    if (!stillCurrent(session)) return;
    catalog = rows;
    el('catalogSelect').replaceChildren(...catalog.map((row, index) => new Option(row.name, index)));
    el('catalogPicker').hidden = !catalog.length;
    setEditorStatus(catalog.length ? '' : say('ຍັງບໍ່ມີລາຍການສິນຄ້າ', '商品目录为空'), false);
  } catch (error) {
    if (stillCurrent(session)) setEditorStatus(friendlyError(error), true);
  } finally {
    button.disabled = false;
  }
});

el('addCatalogBtn').addEventListener('click', () => {
  const row = catalog[el('catalogSelect').value];
  if (!row) return;
  items.push({name:row.name, workDetail:row.work_detail, width:row.width ?? '', height:row.height ?? '',
    sizeUnit:row.size_unit, qty:1, price:Number(row.price), useArea:row.use_area});
  renderItemsForm();
  updatePreview();
});

try {
  const saved = JSON.parse(localStorage.getItem(preferenceKey) || 'null');
  if (saved) connectProject(normalizeProject(saved.url, saved.key));
} catch (error) {
  setEditorStatus(friendlyError(error), true);
}
updateAccountUI();
