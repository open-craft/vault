import { next } from '@ember/runloop';
import { inject as service } from '@ember/service';
import { match, alias, or } from '@ember/object/computed';
import { assign } from '@ember/polyfills';
import { dasherize } from '@ember/string';
import Component from '@ember/component';
import { get, computed } from '@ember/object';
import { supportedAuthBackends } from 'vault/helpers/supported-auth-backends';
import { task, timeout, waitForEvent } from 'ember-concurrency';
const BACKENDS = supportedAuthBackends();

const DEFAULTS = {
  token: null,
  username: null,
  password: null,
  customPath: null,
  role: null,
};

export default Component.extend(DEFAULTS, {
  router: service(),
  auth: service(),
  flashMessages: service(),
  store: service(),
  csp: service('csp-event'),

  //  passed in via a query param
  selectedAuth: null,
  methods: null,
  cluster: null,
  redirectTo: null,
  namespace: null,
  wrappedToken: null,
  // internal
  oldNamespace: null,
  didReceiveAttrs() {
    this._super(...arguments);
    let token = this.get('wrappedToken');
    let newMethod = this.get('selectedAuth');
    let oldMethod = this.get('oldSelectedAuth');

    let ns = this.get('namespace');
    let oldNS = this.get('oldNamespace');
    if (oldNS === null || oldNS !== ns) {
      this.get('fetchMethods').perform();
    }
    this.set('oldNamespace', ns);
    if (oldMethod && oldMethod !== newMethod) {
      this.resetDefaults();
    }
    this.set('oldSelectedAuth', newMethod);

    if (token) {
      this.get('unwrapToken').perform(token);
    }
  },

  didRender() {
    this._super(...arguments);
    let firstMethod = this.firstMethod();
    // on very narrow viewports the active tab may be overflowed, so we scroll it into view here
    let activeEle = this.element.querySelector('li.is-active');
    if (activeEle) {
      activeEle.scrollIntoView();
    }
    // set `with` to the first method
    if (
      (this.get('fetchMethods.isIdle') && firstMethod && !this.get('selectedAuth')) ||
      (this.get('selectedAuth') && !this.get('selectedAuthBackend'))
    ) {
      this.set('selectedAuth', firstMethod);
    }
  },

  firstMethod() {
    let firstMethod = this.get('methodsToShow.firstObject');
    if (!firstMethod) return;
    // prefer backends with a path over those with a type
    return get(firstMethod, 'path') || get(firstMethod, 'type');
  },

  resetDefaults() {
    this.setProperties(DEFAULTS);
  },

  selectedAuthIsPath: match('selectedAuth', /\/$/),
  selectedAuthBackend: computed('methods', 'methods.[]', 'selectedAuth', 'selectedAuthIsPath', function() {
    let methods = this.get('methods');
    let selectedAuth = this.get('selectedAuth');
    let keyIsPath = this.get('selectedAuthIsPath');
    if (!methods) {
      return {};
    }
    if (keyIsPath) {
      return methods.findBy('path', selectedAuth);
    }
    return BACKENDS.findBy('type', selectedAuth);
  }),

  providerPartialName: computed('selectedAuthBackend', function() {
    let type = this.get('selectedAuthBackend.type') || 'token';
    type = type.toLowerCase();
    let templateName = dasherize(type);
    return `partials/auth-form/${templateName}`;
  }),

  hasCSPError: alias('csp.connectionViolations.firstObject'),

  cspErrorText: `This is a standby Vault node but can't communicate with the active node via request forwarding. Sign in at the active node to use the Vault UI.`,

  allSupportedMethods: computed('methodsToShow', 'hasMethodsWithPath', function() {
    let hasMethodsWithPath = this.get('hasMethodsWithPath');
    let methodsToShow = this.get('methodsToShow');
    return hasMethodsWithPath ? methodsToShow.concat(BACKENDS) : methodsToShow;
  }),

  hasMethodsWithPath: computed('methodsToShow', function() {
    return this.get('methodsToShow').isAny('path');
  }),
  methodsToShow: computed('methods', function() {
    let methods = this.get('methods') || [];
    let shownMethods = methods.filter(m =>
      BACKENDS.find(b => get(b, 'type').toLowerCase() === get(m, 'type').toLowerCase())
    );
    return shownMethods.length ? shownMethods : BACKENDS;
  }),

  isOIDC: computed('role', 'selectedAuthBackend.type', function() {
    return this.role && this.role.authUrl && this.selectedAuthBackend.type === 'jwt';
  }),

  unwrapToken: task(function*(token) {
    // will be using the token auth method, so set it here
    this.set('selectedAuth', 'token');
    let adapter = this.get('store').adapterFor('tools');
    try {
      let response = yield adapter.toolAction('unwrap', null, { clientToken: token });
      this.set('token', response.auth.client_token);
      next(() => {
        this.send('doSubmit');
      });
    } catch (e) {
      this.set('error', `Token unwrap failed: ${e.errors[0]}`);
    }
  }),

  fetchMethods: task(function*() {
    let store = this.get('store');
    try {
      let methods = yield store.findAll('auth-method', {
        adapterOptions: {
          unauthenticated: true,
        },
      });
      this.set('methods', methods.map(m => m.serialize({ includeId: true })));
      next(() => {
        store.unloadAll('auth-method');
      });
    } catch (e) {
      this.set('error', `There was an error fetching auth methods: ${e.errors[0]}`);
    }
  }),

  showLoading: or('authenticate.isRunning', 'fetchMethods.isRunning', 'unwrapToken.isRunning'),

  handleError(e) {
    this.set('loading', false);
    if (!e.errors) {
      return e;
    }
    let errors = e.errors.map(error => {
      if (error.detail) {
        return error.detail;
      }
      return error;
    });
    this.set('error', `Authentication failed: ${errors.join('.')}`);
  },

  authenticate: task(function*(backendType, data) {
    let clusterId = this.cluster.id;
    let targetRoute = this.redirectTo || 'vault.cluster';
    try {
      let authResponse = yield this.auth.authenticate({ clusterId, backend: backendType, data });

      let { isRoot, namespace } = authResponse;
      let transition = this.router.transitionTo(targetRoute, { queryParams: { namespace } });
      // returning this w/then because if we keep it
      // in the task, it will get cancelled when the component in un-rendered
      return transition.followRedirects().then(() => {
        if (isRoot) {
          this.flashMessages.warning(
            'You have logged in with a root token. As a security precaution, this root token will not be stored by your browser and you will need to re-authenticate after the window is closed or refreshed.'
          );
        }
      });
    } catch (e) {
      this.handleError(e);
    }
  }),

  handleOIDCError(err) {
    this.set('error', err);
  },

  prepareForOIDC: task(function*(oidcWindow) {
    this.waitForClose.perform(oidcWindow);
    let onMessageEvent = yield waitForEvent(window, 'message');
    this.exchangeOIDC.perform(onMessageEvent, oidcWindow);
  }),

  waitForClose: task(function*(oidcWindow) {
    while (true) {
      yield timeout(500);
      if (!oidcWindow || oidcWindow.closed) {
        return this.handleOIDCError('windowClosed');
      }
    }
  }),

  closeWindow(oidcWindow) {
    this.waitForClose.cancelAll();
    oidcWindow.close();
  },

  exchangeOIDC: task(function*(event, oidcWindow) {
    let { namespace, path, state, code } = event.data;
    this.closeWindow(oidcWindow);
    if (!path || !state || !code) {
      return this.handleOIDCError('missingParams');
    }
    let adapter = this.store.adapterFor('auth-method');
    // this might be bad to mutate the outer state
    this.set('namespace', namespace);
    let resp = yield adapter.exchangeOIDC(path, state, code);
    let token = resp.auth.client_token;
    this.set('selectedAuth', 'token');
    this.set('token', token);
    yield this.send('doSubmit');
  }),

  actions: {
    doSubmit(e) {
      if (e) {
        e.preventDefault();
      }
      let data = {};
      this.setProperties({
        error: null,
      });
      let backend = this.get('selectedAuthBackend') || {};
      let backendMeta = BACKENDS.find(
        b => (get(b, 'type') || '').toLowerCase() === (get(backend, 'type') || '').toLowerCase()
      );
      let attributes = get(backendMeta || {}, 'formAttributes') || {};

      data = assign(data, this.getProperties(...attributes));
      if (this.get('customPath') || get(backend, 'id')) {
        data.path = this.get('customPath') || get(backend, 'id');
      }
      return this.authenticate.perform(backend.type, data);
    },

    startOIDCAuth(e) {
      e.preventDefault();
      if (!this.isOIDC) {
        return;
      }

      let oidcWindow = window.open(
        this.role.authUrl,
        'vaultOIDCWindow',
        'width=500,height=600,resizable,scrollbars=yes,centerscreen=yes,chrome=yes'
      );
      this.prepareForOIDC.perform(oidcWindow);
    },
  },
});
