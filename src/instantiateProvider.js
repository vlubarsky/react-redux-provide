import shallowEqual from './shallowEqual';
import getRelevantKeys from './getRelevantKeys';
import createProviderStore from './createProviderStore';
import { pushOnReady, unshiftOnReady, unshiftMiddleware } from './keyConcats';

const globalProviderInstances = {};

/**
 * Instantiates a provider with its own store.
 *
 * @param {Object} fauxInstance resembles { props, context }
 * @param {Object} provider
 * @param {String|Function} providerKey Optional
 * @param {Function} readyCallback Optional unless providerKey exists
 * @return {Object}
 * @api public
 */
export default function instantiateProvider(
  fauxInstance,
  provider,
  providerKey,
  readyCallback
) {
  if (arguments.length < 4) {
    readyCallback = providerKey;
    providerKey = provider.key;
  }

  const { context } = fauxInstance;
  const providers = getProviders(fauxInstance);
  const providerInstances = getProviderInstances(fauxInstance);
  let providerInstance;
  let isStatic = typeof providerKey !== 'function';

  if (!isStatic) {
    // get actual `providerKey`
    providerKey = providerKey(fauxInstance);
    // if actual `providerKey` matches `key`, treat as static provider
    isStatic = providerKey === provider.key;
  }

  providerInstance = provider.isGlobal
    ? globalProviderInstances[providerKey]
    : providerInstances && providerInstances[providerKey];

  if (fauxInstance.relevantProviders) {
    fauxInstance.relevantProviders[providerKey] = true;
  }

  if (providerInstance) {
    if (readyCallback) {
      if (providerInstance.ready) {
        readyCallback(providerInstance);
      } else {
        pushOnReady({ providerInstance }, readyCallback);
      }
    }

    return providerInstance;
  }

  if (!provider.hasThunk) {
    provider.hasThunk = true;

    if (provider.wait && !Array.isArray(provider.wait)) {
      provider.wait = [ provider.wait ];
    }

    if (provider.clear && !Array.isArray(provider.clear)) {
      provider.clear = [ provider.clear ];
    }

    function findProvider(props) {
      if (getRelevantKeys(provider.reducers, props).length) {
        return provider;
      }

      for (let key in providers) {
        if (getRelevantKeys(providers[key].reducers, props).length) {
          return providers[key];
        }
      }

      return provider;
    }

    function getResultInstances(result, callback) {
      const resultInstances = [];
      let semaphore = result && result.length;
      function clear() {
        if (--semaphore === 0) {
          callback(resultInstances);
        }
      }

      if (!semaphore) {
        semaphore = 1;
        clear();
        return;
      }

      result.forEach((resultProps, index) => {
        resultInstances[index] = null;

        instantiateProvider(
          { props: resultProps, context },
          findProvider(resultProps),
          resultInstance => {
            resultInstances[index] = resultInstance;
            clear();
          }
        );
      });
    }

    function getInstance(props, callback) {
      return instantiateProvider(
        { props, context },
        findProvider(props),
        callback
      );
    }

    function setStates(states) {
      const settingStates = [];
      const { clientStates } = window;

      for (let providerKey in states) {
        const state = states[providerKey];
        const providerInstance = providerInstances[providerKey];

        if (providerInstance) {
          if (providerInstance.store.setState) {
            settingStates.push(() => providerInstance.store.setState(state));
          }
        } else {
          clientStates[providerKey] = state;
        }
      }

      // need to `setState` after any `clientStates` are cached
      while (settingStates.length) {
        settingStates.shift()();
      }
    }

    function dispatchAll(actions) {
      for (let { providerKey, action } of actions) {
        let providerInstance = providerInstances[providerKey];

        if (providerInstance) {
          providerInstance.store.dispatch(action);
        }
      }
    }

    function find(props, doInstantiate, callback) {
      if (arguments.length === 2) {
        callback = doInstantiate;
        doInstantiate = false;
      }

      handleQueries({ props, context }, () => {
        if (!doInstantiate) {
          callback(props.query ? props.result : props.results);
          return;
        }

        if (props.query) {
          getResultInstances(props.result, callback);
          return;
        }

        const { results } = props;
        const resultsInstances = {};
        const resultsKeys = results && Object.keys(results);
        let semaphore = resultsKeys && resultsKeys.length;
        function clear() {
          if (--semaphore === 0) {
            callback(resultsInstances);
          }
        }

        if (!semaphore) {
          semaphore = 1;
          clear();
        }

        resultsKeys.forEach(resultKey => {
          resultsInstances[resultKey] = [];

          getResultInstances(
            results[resultKey],
            resultInstances => {
              resultsInstances[resultKey] = resultInstances;
              clear();
            }
          );
        });
      });
    }

    const providerApi = { getInstance, setStates, dispatchAll, find };

    unshiftMiddleware({ provider }, ({ dispatch, getState }) => {
      return next => action => {
        if (typeof action !== 'function') {
          return next(action);
        }

        if (provider.wait) {
          provider.wait.forEach(fn => fn());
        }

        return action(action => {
          const state = store.getState();
          let storeChanged = false;

          dispatch(action);

          if (provider.clear) {
            storeChanged = state !== store.getState();
            provider.clear.forEach(fn => fn(storeChanged));
          }
        }, getState, providerApi);
      };
    });
  }

  if (provider.wait) {
    provider.wait.forEach(fn => fn());
  }

  providerInstance = Object.create(provider);
  providerInstance.providerKey = providerKey;
  providerInstance.isStatic = isStatic;

  const store = createProviderStore(providerInstance);
  const initialState = store.getState();
  const { actions } = providerInstance;
  const actionCreators = {};

  const setKey = store.setKey;
  store.setKey = (newKey, readyCallback) => {
    if (provider.wait) {
      provider.wait.forEach(fn => fn());
    }

    setKey(newKey, () => {
      if (Array.isArray(providerInstance.onReady)) {
        providerInstance.onReady.forEach(fn => fn(providerInstance));
      } else {
        providerInstance.onReady(providerInstance);
      }

      if (readyCallback) {
        readyCallback();
      }

      if (provider.clear) {
        provider.clear.forEach(fn => fn(true));
      }
    });
  };

  for (let actionKey in actions) {
    actionCreators[actionKey] = function() {
      return store.dispatch(actions[actionKey].apply(this, arguments));
    };
  }

  providerInstance.store = store;
  providerInstance.actionCreators = actionCreators;

  if (provider.isGlobal) {
    globalProviderInstances[providerKey] = providerInstance;
  }
  if (providerInstances) {
    providerInstances[providerKey] = providerInstance;
  }
  if (!provider.instances) {
    provider.instances = [];
  }
  provider.instances.push(providerInstance);

  if (provider.subscribers) {
    Object.keys(provider.subscribers).forEach(key => {
      const handler = provider.subscribers[key];
      const subProvider = providers[key];
      function callHandler() {
        const subProviderInstances = subProvider.instances;

        if (subProviderInstances) {
          subProviderInstances.forEach(subProviderInstance => {
            handler(providerInstance, subProviderInstance);
          });
        }
      }

      if (!subProvider.subscribeTo) {
        subProvider.subscribeTo = {};
      }
      if (!subProvider.subscribeTo[provider.key]) {
        subProvider.subscribeTo[provider.key] = handler;
      }

      providerInstance.store.subscribe(callHandler);
      callHandler();
    });
  }

  if (provider.subscribeTo) {
    Object.keys(provider.subscribeTo).forEach(key => {
      const handler = provider.subscribeTo[key];
      const supProvider = providers[key];

      if (!supProvider.subscribers) {
        supProvider.subscribers = {};
      }
      if (!supProvider.subscribers[provider.key]) {
        supProvider.subscribers[provider.key] = handler;

        if (supProvider.instances) {
          supProvider.instances.forEach(supProviderInstance => {
            supProviderInstance.store.subscribe(() => {
              provider.instances.forEach(providerInstance => {
                handler(supProviderInstance, providerInstance);
              });
            });
          });
        }
      }

      if (supProvider.instances) {
        supProvider.instances.forEach(supProviderInstance => {
          handler(supProviderInstance, providerInstance);
        });
      }
    });
  }

  if (providerInstance.onInstantiated) {
    if (Array.isArray(providerInstance.onInstantiated)) {
      providerInstance.onInstantiated.forEach(fn => fn(providerInstance));
    } else {
      providerInstance.onInstantiated(providerInstance);
    }
  }

  unshiftOnReady({ providerInstance }, () => {
    providerInstance.ready = true;
  });

  if (readyCallback) {
    pushOnReady({ providerInstance }, readyCallback);
  }

  function done() {
    if (Array.isArray(providerInstance.onReady)) {
      providerInstance.onReady.forEach(fn => fn(providerInstance));
    } else {
      providerInstance.onReady(providerInstance);
    }

    if (provider.clear) {
      const storeChanged = initialState !== providerInstance.store.getState();
      provider.clear.forEach(fn => fn(storeChanged));
    }
  }

  if (provider.replication && store.onReady && !store.initializedReplication) {
    store.onReady(done);
  } else {
    done();
  }

  return providerInstance;
}

export function getFromContextOrProps(fauxInstance, key, defaultValue) {
  if (typeof fauxInstance[key] === 'undefined') {
    const { props, context } = fauxInstance;

    if (typeof props[key] !== 'undefined') {
      fauxInstance[key] = props[key];
    } else if (typeof context[key] !== 'undefined') {
      fauxInstance[key] = context[key];
    } else {
      fauxInstance[key] = defaultValue;
    }
  }

  return fauxInstance[key];
}

export function getProviders(fauxInstance) {
  return getFromContextOrProps(fauxInstance, 'providers', {});
}

export function getProviderInstances(fauxInstance) {
  return getFromContextOrProps(fauxInstance, 'providerInstances', {});
}

export function getActiveQueries(fauxInstance) {
  return getFromContextOrProps(fauxInstance, 'activeQueries', {});
}

export function getQueryResults(fauxInstance) {
  return getFromContextOrProps(fauxInstance, 'queryResults', {});
}

export function getFunctionOrObject(fauxInstance, key, defaultValue = null) {
  if (typeof fauxInstance[key] !== 'undefined') {
    return fauxInstance[key];
  }

  let value = fauxInstance.props[key];

  if (typeof value === 'function') {
    value = value(fauxInstance);
  }

  fauxInstance[key] = value || defaultValue;

  return fauxInstance[key];
}

export function getQueries(fauxInstance) {
  if (typeof fauxInstance.queries !== 'undefined') {
    return fauxInstance.queries;
  }

  const { props, context, relevantProviders } = fauxInstance;
  const { providers } = context;
  const query = getQuery(fauxInstance);
  let queries = getFunctionOrObject(fauxInstance, 'queries');
  let hasQueries = false;

  if (query) {
    // we need to map the query to relevant provider(s)
    if (!queries) {
      queries = {};
    } else if (typeof props.queries !== 'function') {
      queries = { ...queries };
    }

    for (let key in providers) {
      let provider = providers[key];
      let queryKeys = getRelevantKeys(provider.reducers, query);

      if (queryKeys.length) {
        // provider is relevant, so we map it within the queries object
        if (!queries[key]) {
          queries[key] = {};
        }

        for (let queryKey of queryKeys) {
          queries[key][queryKey] = query[queryKey];
        }
      }
    }
  }

  for (let key in queries) {
    let query = queries[key];

    if (typeof query === 'function') {
      queries[key] = query(fauxInstance);
    }

    // make sure each provider is instantiated
    instantiateProvider(fauxInstance, providers[key]);
    hasQueries = true;
  }

  if (!hasQueries) {
    queries = null;

    if (props.query) {
      props.result = null;
    }

    if (props.queries) {
      props.results = {};
    }
  }

  return queries;
}

export function getQuery(fauxInstance) {
  return getFunctionOrObject(fauxInstance, 'query');
}

export function getQueryOptions(fauxInstance) {
  return getFunctionOrObject(fauxInstance, 'queryOptions');
}

export function getQueriesOptions(fauxInstance) {
  return getFunctionOrObject(fauxInstance, 'queriesOptions', {});
}

// finds the first `handleQuery` function within replicators
export function getQueryHandler(provider) {
  let { replication } = provider;

  if (replication) {
    if (!Array.isArray(replication)) {
      replication = [ replication ];
    }

    for (let { replicator, reducerKeys } of replication) {
      if (replicator) {
        if (!Array.isArray(replicator)) {
          replicator = [ replicator ];
        }

        for (let { handleQuery } of replicator) {
          if (handleQuery) {
            return {
              handleQuery,
              reducerKeys: reducerKeys || Object.keys(provider.reducers)
            };
          }
        }
      }
    }
  }

  return null;
}

export function getMergedResult(results) {
  let mergedResult = null;

  for (let providerKey in results) {
    let result = results[providerKey];

    if (Array.isArray(result)) {
      mergedResult = [ ...(mergedResult || []), ...result ];
    } else if (result && typeof result === 'object') {
      mergedResult = { ...(mergedResult || {}), ...result };
    } else if (typeof result !== 'undefined') {
      mergedResult = result;
    }
  }

  return mergedResult;
}

export function handleQueries(fauxInstance, callback) {
  const queries = getQueries(fauxInstance);

  if (!queries) {
    if (callback) {
      callback();
    }

    return false;
  }

  const { props, context } = fauxInstance;
  const query = getQuery(fauxInstance);
  const queryOptions = getQueryOptions(fauxInstance);
  const queriesOptions = getQueriesOptions(fauxInstance);
  const activeQueries = getActiveQueries(fauxInstance);
  const queryResults = getQueryResults(fauxInstance);
  const providers = getProviders(fauxInstance);
  const previousResults = props.results || {};

  let semaphore = Object.keys(queries).length;
  const clear = () => {
    if (--semaphore === 0) {
      if (query) {
        props.result = getMergedResult(props.results);
      }

      if (fauxInstance.doUpdate && fauxInstance.update) {
        // TODO: should mergers be checked (again) ??
        fauxInstance.update();
      }

      if (callback) {
        callback();
      }
    }
  };

  if (props.query) {
    props.result = null;
  }

  props.results = {};

  for (let key in queries) {
    let provider = providers[key];
    let query = queries[key];
    let options = queryOptions || queriesOptions[key] || {};
    let resultKey = JSON.stringify({ query, options });
    let queryResult = queryResults[resultKey];

    if (typeof queryResult !== 'undefined') {
      props.results[key] = queryResult;
      clear();
      continue;
    }

    if (provider.wait) {
      if (Array.isArray(provider.wait)) {
        provider.wait.forEach(fn => fn());
      } else {
        provider.wait();
      }
    }

    let resultHandlers = activeQueries[resultKey];
    let resultHandler = result => {
      const previousResult = previousResults[key];

      if (!fauxInstance.doUpdate && !shallowEqual(result, previousResult)) {
        fauxInstance.doUpdate = true;
      }

      props.results[key] = result;
      queryResults[resultKey] = result;

      clear();

      if (provider.clear) {
        if (Array.isArray(provider.clear)) {
          provider.clear.forEach(fn => fn(fauxInstance.doUpdate));
        } else {
          provider.clear();
        }
      }
    };

    if (resultHandlers) {
      resultHandlers.push(resultHandler);
    } else {
      let { handleQuery, reducerKeys } = getQueryHandler(provider);

      if (typeof options.select === 'undefined') {
        options.select = reducerKeys;
      } else if (!Array.isArray(options.select)) {
        options.select = [ options.select ];
      }

      resultHandlers = [ resultHandler ];
      activeQueries[resultKey] = resultHandlers;

      handleQuery(query, options, result => {
        delete activeQueries[resultKey];

        while (resultHandlers.length) {
          resultHandlers.shift()(result);
        }
      });
    }
  }

  return true;
}
