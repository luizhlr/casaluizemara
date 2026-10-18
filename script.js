/* Chá de Casa Nova - Luiz e Mara
   Lógica da página: carrega a lista, deixa o convidado escolher (carrinho),
   envia o pedido ao Apps Script e mostra a confirmação.

   Regra de segurança: todo texto que vem de fora (nomes de itens, lojas,
   mensagens do servidor) entra na página com textContent / createTextNode,
   nunca com innerHTML. */

(function () {
  'use strict';

  // =====================================================================
  // CONFIGURAÇÃO: cole aqui a URL do Apps Script (a que termina em /exec)
  // =====================================================================
  var API_URL = 'https://script.google.com/macros/s/AKfycbx7oIzvW_d3bfPyozykbG3XjFYNnh67CtiX7KHX8VG0mJ6W-u2bgaB3w4c1n7UsanEM/exec';

  var TIMEOUT_MS = 25000;
  var MIN_NOME = 2;
  var MAX_NOME = 80;
  var MAX_MSG = 500;
  var CHAVE_RASCUNHO = 'cha-casa-nova-rascunho-v1';
  var RECARGA_APOS_MS = 60000;

  // ---------------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------------
  var state = {
    itens: [],        // [{id, name, store, total, remaining}]
    porId: {},
    sel: {},          // id -> quantidade escolhida
    refs: {},         // id -> elementos do cartão
    refsRev: {},      // id -> elementos da linha na janela de revisão
    busca: '',
    ocultar: false,
    enviando: false,
    pendente: null,   // {chave, id}: mantém o mesmo identificador de envio ao tentar de novo
    ultimaCarga: 0
  };

  function $(id) { return document.getElementById(id); }

  var elGrade = $('grade');
  var elEstado = $('estado');
  var elContagem = $('contagem');
  var elResumo = $('resumo');
  var btnRevisar = $('btn-revisar');
  var dlg = $('dlg');
  var formRev = $('vista-revisar');
  var vistaOk = $('vista-sucesso');
  var elRevLista = $('rev-lista');
  var elRevErro = $('rev-erro');
  var btnEnviar = $('btn-enviar');
  var btnVoltar = $('btn-voltar');
  var btnFechar = $('btn-fechar');

  // ---------------------------------------------------------------------
  // Utilitários
  // ---------------------------------------------------------------------
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else n.setAttribute(k, v === true ? '' : v);
      });
    }
    (kids || []).forEach(function (c) {
      if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  function limpar(no) { while (no.firstChild) no.removeChild(no.firstChild); }

  function plural(n, um, varios) { return n + ' ' + (n === 1 ? um : varios); }

  function normalizar(s) {
    return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function limparNome(s) {
    return String(s).replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  function novoIdEnvio() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    } catch (e) { /* segue para o plano B */ }
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }

  // Chamada ao servidor. Para o POST uso "text/plain": é um tipo de requisição
  // "simples", que o navegador envia sem a checagem prévia (preflight) que o
  // Apps Script não sabe responder. É assim que um site em outro endereço
  // consegue gravar no Apps Script sem erro de CORS.
  function chamar(url, opcoes) {
    return new Promise(function (resolve, reject) {
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var o = opcoes || {};
      if (ctrl) o.signal = ctrl.signal;
      var timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        reject(new Error('tempo'));
      }, TIMEOUT_MS);
      fetch(url, o).then(function (res) {
        return res.text();
      }).then(function (txt) {
        clearTimeout(timer);
        var dados;
        try { dados = JSON.parse(txt); } catch (e) { reject(new Error('formato')); return; }
        resolve(dados);
      }).catch(function () {
        clearTimeout(timer);
        reject(new Error('rede'));
      });
    });
  }

  // ---------------------------------------------------------------------
  // Rascunho (só neste aparelho, só enquanto a aba estiver aberta)
  // ---------------------------------------------------------------------
  function salvarRascunho() {
    try {
      sessionStorage.setItem(CHAVE_RASCUNHO, JSON.stringify({
        sel: state.sel,
        nome: $('f-nome').value,
        msg: $('f-msg').value
      }));
    } catch (e) { /* sem armazenamento: tudo bem */ }
  }

  function restaurarRascunho() {
    try {
      var bruto = sessionStorage.getItem(CHAVE_RASCUNHO);
      if (!bruto) return;
      var d = JSON.parse(bruto);
      if (d && typeof d.sel === 'object' && d.sel) {
        Object.keys(d.sel).forEach(function (id) {
          var q = d.sel[id];
          if (/^[A-Za-z0-9_-]{1,20}$/.test(id) && typeof q === 'number' && q >= 1 && Math.floor(q) === q) state.sel[id] = q;
        });
      }
      if (d && typeof d.nome === 'string') $('f-nome').value = d.nome.slice(0, MAX_NOME);
      if (d && typeof d.msg === 'string') $('f-msg').value = d.msg.slice(0, MAX_MSG);
    } catch (e) { /* ignora */ }
  }

  // ---------------------------------------------------------------------
  // Mensagens de estado (carregando, erro, vazio)
  // ---------------------------------------------------------------------
  function mostrarEstado(tipo, texto) {
    limpar(elEstado);
    elEstado.classList.toggle('com-erro', tipo === 'erro' || tipo === 'config');
    if (tipo === 'carregando') {
      elEstado.appendChild(el('p', { text: 'Carregando a lista de presentes...' }));
    } else if (tipo === 'erro') {
      elEstado.appendChild(el('p', { text: texto || 'Não foi possível carregar a lista agora.' }));
      var b = el('button', { class: 'btn btn-secundario', type: 'button', text: 'Tentar de novo' });
      b.addEventListener('click', function () { carregarLista(false); });
      elEstado.appendChild(b);
    } else if (tipo === 'config') {
      elEstado.appendChild(el('p', { text: 'Este site ainda não foi conectado à planilha. Falta colocar a URL do Apps Script no arquivo script.js.' }));
    } else if (tipo === 'vazio') {
      elEstado.appendChild(el('p', { text: texto }));
      if (state.itens.length > 0) {
        var l = el('button', { class: 'btn btn-secundario', type: 'button', text: 'Limpar filtros' });
        l.addEventListener('click', function () {
          $('busca').value = ''; $('ocultar').checked = false;
          state.busca = ''; state.ocultar = false; aplicarFiltro();
        });
        elEstado.appendChild(l);
      }
    }
    elEstado.hidden = false;
  }

  function esconderEstado() { elEstado.hidden = true; limpar(elEstado); }

  // ---------------------------------------------------------------------
  // Carregar e aplicar a lista
  // ---------------------------------------------------------------------
  function carregarLista(silencioso) {
    if (!silencioso) { limpar(elGrade); mostrarEstado('carregando'); }
    var url = API_URL + (API_URL.indexOf('?') === -1 ? '?' : '&') + 'v=' + Date.now();
    return chamar(url, { method: 'GET', redirect: 'follow' }).then(function (r) {
      if (!r || r.ok !== true || !Array.isArray(r.items)) throw new Error('formato');
      aplicarItens(r.items);
    }).catch(function () {
      if (!silencioso) mostrarEstado('erro', 'Não foi possível carregar a lista. Verifique sua internet e tente de novo.');
    });
  }

  function aplicarItens(lista) {
    var validos = [];
    (Array.isArray(lista) ? lista : []).forEach(function (it) {
      if (!it || typeof it.id !== 'string' || !/^[A-Za-z0-9_-]{1,20}$/.test(it.id)) return;
      if (typeof it.name !== 'string' || it.name === '') return;
      var total = Number(it.total), resta = Number(it.remaining);
      if (!isFinite(total) || !isFinite(resta) || total < 1) return;
      validos.push({
        id: it.id,
        name: it.name,
        store: typeof it.store === 'string' ? it.store : '',
        total: total,
        remaining: Math.max(0, Math.min(resta, total))
      });
    });
    state.itens = validos;
    state.porId = {};
    validos.forEach(function (it) { state.porId[it.id] = it; });

    // A escolha nunca passa do que ainda resta.
    Object.keys(state.sel).forEach(function (id) {
      var it = state.porId[id];
      if (!it || it.remaining < 1) delete state.sel[id];
      else if (state.sel[id] > it.remaining) state.sel[id] = it.remaining;
    });

    state.ultimaCarga = Date.now();
    construirGrade();
    atualizarBarra();
    salvarRascunho();
  }

  // ---------------------------------------------------------------------
  // Cartões
  // ---------------------------------------------------------------------
  function construirGrade() {
    limpar(elGrade);
    state.refs = {};
    if (state.itens.length === 0) {
      mostrarEstado('vazio', 'A lista ainda não tem itens.');
      return;
    }
    esconderEstado();
    state.itens.forEach(function (it) {
      var r = criarCard(it);
      state.refs[it.id] = r;
      elGrade.appendChild(r.card);
      atualizarCard(it.id);
    });
    aplicarFiltro();
  }

  function criarCard(item) {
    var img = el('img', { alt: '', loading: 'lazy', decoding: 'async' });
    var foto = el('div', { class: 'foto' }, [img]);
    var selo = el('span', { class: 'selo', text: 'Já reservado' });
    var marca = el('span', { class: 'marca', text: 'Escolhido' });
    selo.hidden = true; marca.hidden = true;
    foto.appendChild(selo); foto.appendChild(marca);
    img.addEventListener('load', function () {
      if (img.naturalWidth && img.naturalHeight && img.naturalWidth / img.naturalHeight > 0.9) foto.classList.add('contida');
    });
    img.addEventListener('error', function () { foto.classList.add('sem-foto'); });
    img.src = 'fotos/' + item.id + '.jpg';

    var disp = el('p', { class: 'disp' });
    var btnEscolher = el('button', { class: 'btn btn-escolher', type: 'button', text: 'Escolher', 'aria-label': 'Escolher: ' + item.name });
    var btnMenos = el('button', { class: 'step-btn', type: 'button', text: '−', 'aria-label': 'Tirar uma unidade de ' + item.name });
    var btnMais = el('button', { class: 'step-btn', type: 'button', text: '+', 'aria-label': 'Adicionar uma unidade de ' + item.name });
    var valor = el('span', { class: 'step-valor', 'aria-live': 'polite', text: '0' });
    var stepper = el('div', { class: 'stepper', role: 'group', 'aria-label': 'Quantidade de ' + item.name }, [btnMenos, valor, btnMais]);
    stepper.hidden = true;

    var corpo = el('div', { class: 'corpo' }, [
      el('h3', { class: 'nome', text: item.name }),
      item.store ? el('p', { class: 'loja', text: item.store }) : null,
      disp,
      el('div', { class: 'acao' }, [btnEscolher, stepper])
    ]);
    var card = el('li', { class: 'card', 'data-id': item.id }, [foto, corpo]);

    btnEscolher.addEventListener('click', function () { setQtd(item.id, 1); });
    btnMais.addEventListener('click', function () { setQtd(item.id, (state.sel[item.id] || 0) + 1); });
    btnMenos.addEventListener('click', function () { setQtd(item.id, (state.sel[item.id] || 0) - 1); });

    return {
      card: card, foto: foto, selo: selo, marca: marca, disp: disp,
      btnEscolher: btnEscolher, btnMenos: btnMenos, btnMais: btnMais,
      valor: valor, stepper: stepper
    };
  }

  function textoDisponibilidade(it) {
    if (it.remaining < 1) return 'Esgotado';
    if (it.remaining < it.total) return 'Restam ' + it.remaining + ' de ' + it.total;
    if (it.total > 1) return it.total + ' disponíveis';
    return 'Disponível';
  }

  function atualizarCard(id) {
    var r = state.refs[id], it = state.porId[id];
    if (!r || !it) return;
    var q = state.sel[id] || 0;
    var esgotado = it.remaining < 1;
    r.card.classList.toggle('esgotado', esgotado);
    r.card.classList.toggle('escolhido', q > 0);
    r.selo.hidden = !esgotado;
    r.marca.hidden = !(q > 0);
    r.marca.textContent = q > 1 ? q + ' escolhidos' : 'Escolhido';
    r.disp.textContent = textoDisponibilidade(it);
    r.btnEscolher.hidden = q > 0;
    r.stepper.hidden = q === 0;
    r.valor.textContent = String(q);
    r.btnMais.disabled = q >= it.remaining;
  }

  // Muda a quantidade de um item (usado pelo cartão e pela janela de revisão).
  function setQtd(id, n) {
    if (state.enviando) return;
    var it = state.porId[id];
    if (!it) return;
    n = Math.floor(n);
    if (!(n >= 0)) n = 0;
    if (n > it.remaining) n = it.remaining;

    var ativo = document.activeElement;
    if (n > 0) state.sel[id] = n; else delete state.sel[id];
    atualizarCard(id);
    atualizarBarra();
    atualizarLinhaRevisao(id);
    salvarRascunho();

    // Se o botão que estava com o foco sumiu ou travou, leva o foco para um vizinho.
    var r = state.refs[id];
    if (r && ativo && r.card.contains(ativo)) {
      if (n === 0) r.btnEscolher.focus();
      else if (ativo === r.btnEscolher || (ativo === r.btnMais && r.btnMais.disabled)) {
        (r.btnMais.disabled ? r.btnMenos : r.btnMais).focus();
      }
    }
  }

  // ---------------------------------------------------------------------
  // Busca e filtro
  // ---------------------------------------------------------------------
  function aplicarFiltro() {
    var termo = normalizar(state.busca.trim());
    var visiveis = 0;
    state.itens.forEach(function (it) {
      var r = state.refs[it.id];
      if (!r) return;
      var ok = true;
      if (termo && normalizar(it.name).indexOf(termo) === -1) ok = false;
      if (state.ocultar && it.remaining < 1) ok = false;
      r.card.hidden = !ok;
      if (ok) visiveis++;
    });
    var total = state.itens.length;
    if (!total) { elContagem.textContent = ''; return; }
    if (termo || state.ocultar) elContagem.textContent = 'Mostrando ' + visiveis + ' de ' + plural(total, 'item', 'itens');
    else elContagem.textContent = plural(total, 'item', 'itens') + ' na lista';

    if (visiveis === 0) {
      mostrarEstado('vazio', termo ? 'Nenhum item encontrado para “' + state.busca.trim() + '”.' : 'Todos os itens já foram reservados.');
    } else if (!elEstado.hidden && !elEstado.classList.contains('com-erro')) {
      esconderEstado();
    }
  }

  // ---------------------------------------------------------------------
  // Barra fixa
  // ---------------------------------------------------------------------
  function contarEscolha() {
    var itens = 0, unidades = 0;
    Object.keys(state.sel).forEach(function (id) {
      if (state.porId[id] && state.sel[id] > 0) { itens++; unidades += state.sel[id]; }
    });
    return { itens: itens, unidades: unidades };
  }

  function atualizarBarra() {
    var c = contarEscolha();
    if (c.itens === 0) {
      elResumo.textContent = 'Escolha os presentes da lista.';
    } else {
      var txt = plural(c.itens, 'item', 'itens');
      if (c.unidades !== c.itens) txt += ', ' + plural(c.unidades, 'unidade', 'unidades');
      elResumo.textContent = txt;
    }
    btnRevisar.disabled = c.itens === 0;
  }

  // ---------------------------------------------------------------------
  // Janela de revisão
  // ---------------------------------------------------------------------
  function abrirDialogo() {
    document.documentElement.classList.add('sem-rolagem');
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  function fecharDialogo() {
    if (typeof dlg.close === 'function' && dlg.open) dlg.close();
    else dlg.removeAttribute('open');
    document.documentElement.classList.remove('sem-rolagem');
  }

  function abrirRevisao() {
    if (contarEscolha().itens === 0) return;
    limparErros();
    vistaOk.hidden = true;
    formRev.hidden = false;
    construirRevisao();
    abrirDialogo();
    $('rev-titulo').focus();
  }

  function construirRevisao() {
    limpar(elRevLista);
    state.refsRev = {};
    state.itens.forEach(function (it) {
      var q = state.sel[it.id] || 0;
      if (q < 1) return;
      var valor = el('span', { class: 'step-valor', text: String(q) });
      var menos = el('button', { class: 'step-btn', type: 'button', text: '−', 'aria-label': 'Tirar uma unidade de ' + it.name });
      var mais = el('button', { class: 'step-btn', type: 'button', text: '+', 'aria-label': 'Adicionar uma unidade de ' + it.name });
      var remover = el('button', { class: 'rev-remover', type: 'button', text: 'Remover', 'aria-label': 'Remover ' + it.name + ' da escolha' });
      var li = el('li', { class: 'rev-item' }, [
        el('div', { class: 'rev-info' }, [el('span', { class: 'rev-nome', text: it.name }), remover]),
        el('div', { class: 'rev-ctrl' }, [menos, valor, mais])
      ]);
      menos.addEventListener('click', function () { setQtd(it.id, (state.sel[it.id] || 0) - 1); });
      mais.addEventListener('click', function () { setQtd(it.id, (state.sel[it.id] || 0) + 1); });
      remover.addEventListener('click', function () { setQtd(it.id, 0); });
      elRevLista.appendChild(li);
      state.refsRev[it.id] = { li: li, valor: valor, menos: menos, mais: mais, remover: remover };
      mais.disabled = q >= it.remaining;
    });
    btnEnviar.disabled = state.enviando || contarEscolha().itens === 0;
  }

  function atualizarLinhaRevisao(id) {
    var r = state.refsRev[id], it = state.porId[id];
    if (!r || !it) return;
    var q = state.sel[id] || 0;
    if (q < 1) {
      var tinhaFoco = r.li.contains(document.activeElement);
      if (r.li.parentNode) r.li.parentNode.removeChild(r.li);
      delete state.refsRev[id];
      if (tinhaFoco) $('rev-titulo').focus();
      if (contarEscolha().itens === 0 && dlg.open && !state.enviando) {
        // Se esvaziou o carrinho, volta para a lista.
        fecharDialogo();
      }
    } else {
      r.valor.textContent = String(q);
      r.mais.disabled = q >= it.remaining;
      if (r.mais.disabled && document.activeElement === r.mais) r.menos.focus();
    }
    btnEnviar.disabled = state.enviando || contarEscolha().itens === 0;
  }

  function limparErros() {
    elRevErro.hidden = true; limpar(elRevErro);
    var en = $('erro-nome'); en.hidden = true; en.textContent = '';
    $('f-nome').removeAttribute('aria-invalid');
  }

  function mostrarErroGeral(mensagem, linhas) {
    limpar(elRevErro);
    elRevErro.appendChild(el('p', { text: mensagem }));
    if (linhas && linhas.length) {
      var ul = el('ul');
      linhas.forEach(function (t) { ul.appendChild(el('li', { text: t })); });
      elRevErro.appendChild(ul);
    }
    elRevErro.hidden = false;
    if (typeof elRevErro.scrollIntoView === 'function') elRevErro.scrollIntoView({ block: 'nearest' });
  }

  function erroNome(texto) {
    var en = $('erro-nome');
    en.textContent = texto; en.hidden = false;
    $('f-nome').setAttribute('aria-invalid', 'true');
    $('f-nome').focus();
  }

  function setEnviando(on) {
    state.enviando = on;
    btnEnviar.disabled = on || contarEscolha().itens === 0;
    btnEnviar.textContent = on ? 'Enviando...' : 'Confirmar reserva';
    btnVoltar.disabled = on;
    btnFechar.disabled = on;
    $('f-nome').readOnly = on;
    $('f-msg').readOnly = on;
    formRev.setAttribute('aria-busy', on ? 'true' : 'false');
    Array.prototype.forEach.call(elRevLista.querySelectorAll('button'), function (b) {
      if (on) { b.setAttribute('data-trava', b.disabled ? '1' : '0'); b.disabled = true; }
      else { b.disabled = b.getAttribute('data-trava') === '1'; b.removeAttribute('data-trava'); }
    });
  }

  // ---------------------------------------------------------------------
  // Envio
  // ---------------------------------------------------------------------
  function enviar(ev) {
    ev.preventDefault();
    if (state.enviando) return;
    limparErros();

    var nome = limparNome($('f-nome').value);
    if (nome.length < MIN_NOME || !/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(nome)) {
      erroNome('Informe seu nome (pelo menos 2 letras).'); return;
    }
    if (nome.length > MAX_NOME) {
      erroNome('O nome está muito longo (máximo de ' + MAX_NOME + ' caracteres).'); return;
    }
    var msg = $('f-msg').value.replace(/\r\n?/g, '\n').trim();
    if (msg.length > MAX_MSG) {
      mostrarErroGeral('A mensagem está muito longa (máximo de ' + MAX_MSG + ' caracteres).'); return;
    }

    var itens = [];
    state.itens.forEach(function (it) {
      var q = state.sel[it.id] || 0;
      if (q > 0) itens.push({ id: it.id, qty: q });
    });
    if (itens.length === 0) { mostrarErroGeral('Escolha pelo menos um item.'); return; }

    // Mesmo pedido = mesmo identificador (o servidor ignora reenvios repetidos).
    var chave = JSON.stringify([nome, msg, itens]);
    if (!state.pendente || state.pendente.chave !== chave) state.pendente = { chave: chave, id: novoIdEnvio() };

    var payload = {
      submissionId: state.pendente.id,
      names: nome,
      message: msg,
      items: itens,
      website: $('f-site').value
    };

    setEnviando(true);
    chamar(API_URL, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      setEnviando(false);
      tratarResposta(r, nome);
    }, function (err) {
      setEnviando(false);
      tratarFalha(err);
    });
  }

  function tratarResposta(r, nomeEnviado) {
    if (r && r.ok === true) { mostrarSucesso(r, nomeEnviado); return; }

    // Qualquer resposta de erro com a lista nova atualiza a página.
    if (r && Array.isArray(r.items)) {
      aplicarItens(r.items);
      construirRevisao();
    }
    var msg = (r && typeof r.message === 'string' && r.message) ? r.message : 'Não foi possível concluir. Tente de novo; se continuar, fale com Luiz ou Mara.';

    if (r && r.code === 'ESGOTADO' && Array.isArray(r.conflicts)) {
      var linhas = r.conflicts.map(function (c) {
        var resta = Number(c.remaining);
        var pediu = Number(c.requested);
        var nome = typeof c.name === 'string' ? c.name : 'Item';
        return resta < 1
          ? nome + ': acabou. Não há mais unidades.'
          : nome + ': você pediu ' + pediu + ' e ' + (resta === 1 ? 'resta 1' : 'restam ' + resta) + '.';
      });
      if (contarEscolha().itens === 0) {
        mostrarErroGeral('Todos os itens que você escolheu foram reservados por outras pessoas enquanto você escolhia. Nada foi gravado. Volte à lista para escolher outros.', linhas);
      } else {
        mostrarErroGeral(msg + ' Já ajustamos as quantidades abaixo.', linhas);
      }
      return;
    }
    mostrarErroGeral(msg);
  }

  function tratarFalha(err) {
    var motivo = err && err.message;
    if (motivo === 'formato') {
      mostrarErroGeral('O servidor respondeu de um jeito inesperado. Nada foi confirmado. Tente de novo em instantes; se continuar, fale com Luiz ou Mara.');
    } else {
      mostrarErroGeral('Não foi possível conectar. Verifique sua internet e toque em "Confirmar reserva" de novo. Se a reserva já tiver sido registrada, o sistema não duplica.');
    }
  }

  function mostrarSucesso(r, nomeEnviado) {
    state.pendente = null;
    var reservados = Array.isArray(r.reserved) ? r.reserved : [];
    var nomes = (typeof r.names === 'string' && r.names) ? r.names : nomeEnviado;

    state.sel = {};
    $('f-msg').value = '';
    $('f-site').value = '';
    if (Array.isArray(r.items)) aplicarItens(r.items); else { atualizarBarra(); carregarLista(true); }
    salvarRascunho();

    $('ok-intro').textContent = nomes + ', sua escolha foi registrada:';
    var lista = $('ok-lista');
    limpar(lista);
    reservados.forEach(function (x) {
      if (!x || typeof x.name !== 'string') return;
      lista.appendChild(el('li', { class: 'rev-item' }, [
        el('span', { class: 'rev-nome', text: x.name }),
        el('span', { class: 'rev-qtd', text: '× ' + Number(x.qty) })
      ]));
    });

    formRev.hidden = true;
    vistaOk.hidden = false;
    if (!dlg.open) abrirDialogo();
    $('ok-titulo').focus();
  }

  // ---------------------------------------------------------------------
  // Início
  // ---------------------------------------------------------------------
  function iniciar() {
    restaurarRascunho();
    atualizarBarra();

    $('busca').addEventListener('input', function (e) { state.busca = e.target.value; aplicarFiltro(); });
    $('ocultar').addEventListener('change', function (e) { state.ocultar = e.target.checked; aplicarFiltro(); });
    btnRevisar.addEventListener('click', abrirRevisao);
    btnFechar.addEventListener('click', fecharDialogo);
    btnVoltar.addEventListener('click', fecharDialogo);
    $('btn-ok').addEventListener('click', fecharDialogo);
    formRev.addEventListener('submit', enviar);
    $('f-nome').addEventListener('input', salvarRascunho);
    $('f-msg').addEventListener('input', salvarRascunho);
    dlg.addEventListener('close', function () { document.documentElement.classList.remove('sem-rolagem'); });
    dlg.addEventListener('cancel', function (e) { if (state.enviando) e.preventDefault(); });

    // Ao voltar para a aba depois de um tempo, atualiza o que resta.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && !dlg.open && !state.enviando &&
          state.ultimaCarga && Date.now() - state.ultimaCarga > RECARGA_APOS_MS) {
        carregarLista(true);
      }
    });

    if (!/^https:\/\//.test(API_URL) || API_URL.indexOf('COLE_AQUI') !== -1) {
      mostrarEstado('config');
      return;
    }
    carregarLista(false);
  }

  iniciar();
})();
