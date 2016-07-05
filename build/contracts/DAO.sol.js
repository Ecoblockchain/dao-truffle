var Web3 = require("web3");

(function() {
  // Planned for future features, logging, etc.
  function Provider(provider) {
    this.provider = provider;
  }

  Provider.prototype.send = function() {
    this.provider.send.apply(this.provider, arguments);
  };

  Provider.prototype.sendAsync = function() {
    this.provider.sendAsync.apply(this.provider, arguments);
  };

  var BigNumber = (new Web3()).toBigNumber(0).constructor;

  var Utils = {
    is_object: function(val) {
      return typeof val == "object" && !Array.isArray(val);
    },
    is_big_number: function(val) {
      if (typeof val != "object") return false;

      // Instanceof won't work because we have multiple versions of Web3.
      try {
        new BigNumber(val);
        return true;
      } catch (e) {
        return false;
      }
    },
    merge: function() {
      var merged = {};
      var args = Array.prototype.slice.call(arguments);

      for (var i = 0; i < args.length; i++) {
        var object = args[i];
        var keys = Object.keys(object);
        for (var j = 0; j < keys.length; j++) {
          var key = keys[j];
          var value = object[key];
          merged[key] = value;
        }
      }

      return merged;
    },
    promisifyFunction: function(fn, C) {
      var self = this;
      return function() {
        var instance = this;

        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {
          var callback = function(error, result) {
            if (error != null) {
              reject(error);
            } else {
              accept(result);
            }
          };
          args.push(tx_params, callback);
          fn.apply(instance.contract, args);
        });
      };
    },
    synchronizeFunction: function(fn, C) {
      var self = this;
      return function() {
        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {

          var callback = function(error, tx) {
            if (error != null) {
              reject(error);
              return;
            }

            var timeout = C.synchronization_timeout || 240000;
            var start = new Date().getTime();

            var make_attempt = function() {
              C.web3.eth.getTransactionReceipt(tx, function(err, receipt) {
                if (err) return reject(err);

                if (receipt != null) {
                  return accept(tx, receipt);
                }

                if (timeout > 0 && new Date().getTime() - start > timeout) {
                  return reject(new Error("Transaction " + tx + " wasn't processed in " + (timeout / 1000) + " seconds!"));
                }

                attempts += 1;

                setTimeout(make_attempt, 1000);
              });
            };

            make_attempt();
          };

          args.push(tx_params, callback);
          fn.apply(self, args);
        });
      };
    }
  };

  function instantiate(instance, contract) {
    instance.contract = contract;
    var constructor = instance.constructor;

    // Provision our functions.
    for (var i = 0; i < instance.abi.length; i++) {
      var item = instance.abi[i];
      if (item.type == "function") {
        if (item.constant == true) {
          instance[item.name] = Utils.promisifyFunction(contract[item.name], constructor);
        } else {
          instance[item.name] = Utils.synchronizeFunction(contract[item.name], constructor);
        }

        instance[item.name].call = Utils.promisifyFunction(contract[item.name].call, constructor);
        instance[item.name].sendTransaction = Utils.promisifyFunction(contract[item.name].sendTransaction, constructor);
        instance[item.name].request = contract[item.name].request;
        instance[item.name].estimateGas = Utils.promisifyFunction(contract[item.name].estimateGas, constructor);
      }

      if (item.type == "event") {
        instance[item.name] = contract[item.name];
      }
    }

    instance.allEvents = contract.allEvents;
    instance.address = contract.address;
  };

  // Use inheritance to create a clone of this contract,
  // and copy over contract's static functions.
  function mutate(fn) {
    var temp = function Clone() { return fn.apply(this, arguments); };

    Object.keys(fn).forEach(function(key) {
      temp[key] = fn[key];
    });

    temp.prototype = Object.create(fn.prototype);
    bootstrap(temp);
    return temp;
  };

  function bootstrap(fn) {
    fn.web3 = new Web3();
    fn.class_defaults  = fn.prototype.defaults || {};

    // Set the network iniitally to make default data available and re-use code.
    // Then remove the saved network id so the network will be auto-detected on first use.
    fn.setNetwork("default");
    fn.network_id = null;
    return fn;
  };

  // Accepts a contract object created with web3.eth.contract.
  // Optionally, if called without `new`, accepts a network_id and will
  // create a new version of the contract abstraction with that network_id set.
  function Contract() {
    if (this instanceof Contract) {
      instantiate(this, arguments[0]);
    } else {
      var C = mutate(Contract);
      var network_id = arguments.length > 0 ? arguments[0] : "default";
      C.setNetwork(network_id);
      return C;
    }
  };

  Contract.currentProvider = null;

  Contract.setProvider = function(provider) {
    var wrapped = new Provider(provider);
    this.web3.setProvider(wrapped);
    this.currentProvider = provider;
  };

  Contract.new = function() {
    if (this.currentProvider == null) {
      throw new Error("DAO error: Please call setProvider() first before calling new().");
    }

    var args = Array.prototype.slice.call(arguments);

    if (!this.binary) {
      throw new Error("DAO error: contract binary not set. Can't deploy new instance.");
    }

    var regex = /__[^_]+_+/g;
    var unlinked_libraries = this.binary.match(regex);

    if (unlinked_libraries != null) {
      unlinked_libraries = unlinked_libraries.map(function(name) {
        // Remove underscores
        return name.replace(/_/g, "");
      }).sort().filter(function(name, index, arr) {
        // Remove duplicates
        if (index + 1 >= arr.length) {
          return true;
        }

        return name != arr[index + 1];
      }).join(", ");

      throw new Error("DAO contains unresolved libraries. You must deploy and link the following libraries before you can deploy a new version of DAO: " + unlinked_libraries);
    }

    var self = this;

    return new Promise(function(accept, reject) {
      var contract_class = self.web3.eth.contract(self.abi);
      var tx_params = {};
      var last_arg = args[args.length - 1];

      // It's only tx_params if it's an object and not a BigNumber.
      if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
        tx_params = args.pop();
      }

      tx_params = Utils.merge(self.class_defaults, tx_params);

      if (tx_params.data == null) {
        tx_params.data = self.binary;
      }

      // web3 0.9.0 and above calls new twice this callback twice.
      // Why, I have no idea...
      var intermediary = function(err, web3_instance) {
        if (err != null) {
          reject(err);
          return;
        }

        if (err == null && web3_instance != null && web3_instance.address != null) {
          accept(new self(web3_instance));
        }
      };

      args.push(tx_params, intermediary);
      contract_class.new.apply(contract_class, args);
    });
  };

  Contract.at = function(address) {
    if (address == null || typeof address != "string" || address.length != 42) {
      throw new Error("Invalid address passed to DAO.at(): " + address);
    }

    var contract_class = this.web3.eth.contract(this.abi);
    var contract = contract_class.at(address);

    return new this(contract);
  };

  Contract.deployed = function() {
    if (!this.address) {
      throw new Error("Cannot find deployed address: DAO not deployed or address not set.");
    }

    return this.at(this.address);
  };

  Contract.defaults = function(class_defaults) {
    if (this.class_defaults == null) {
      this.class_defaults = {};
    }

    if (class_defaults == null) {
      class_defaults = {};
    }

    var self = this;
    Object.keys(class_defaults).forEach(function(key) {
      var value = class_defaults[key];
      self.class_defaults[key] = value;
    });

    return this.class_defaults;
  };

  Contract.extend = function() {
    var args = Array.prototype.slice.call(arguments);

    for (var i = 0; i < arguments.length; i++) {
      var object = arguments[i];
      var keys = Object.keys(object);
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j];
        var value = object[key];
        this.prototype[key] = value;
      }
    }
  };

  Contract.all_networks = {
  "default": {
    "abi": [
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "name": "proposals",
        "outputs": [
          {
            "name": "recipient",
            "type": "address"
          },
          {
            "name": "amount",
            "type": "uint256"
          },
          {
            "name": "description",
            "type": "string"
          },
          {
            "name": "votingDeadline",
            "type": "uint256"
          },
          {
            "name": "open",
            "type": "bool"
          },
          {
            "name": "proposalPassed",
            "type": "bool"
          },
          {
            "name": "proposalHash",
            "type": "bytes32"
          },
          {
            "name": "proposalDeposit",
            "type": "uint256"
          },
          {
            "name": "newCurator",
            "type": "bool"
          },
          {
            "name": "yea",
            "type": "uint256"
          },
          {
            "name": "nay",
            "type": "uint256"
          },
          {
            "name": "creator",
            "type": "address"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_spender",
            "type": "address"
          },
          {
            "name": "_amount",
            "type": "uint256"
          }
        ],
        "name": "approve",
        "outputs": [
          {
            "name": "success",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "minTokensToCreate",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "rewardAccount",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "daoCreator",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "totalSupply",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "divisor",
        "outputs": [
          {
            "name": "divisor",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "extraBalance",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_proposalID",
            "type": "uint256"
          },
          {
            "name": "_transactionData",
            "type": "bytes"
          }
        ],
        "name": "executeProposal",
        "outputs": [
          {
            "name": "_success",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_from",
            "type": "address"
          },
          {
            "name": "_to",
            "type": "address"
          },
          {
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "transferFrom",
        "outputs": [
          {
            "name": "success",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [],
        "name": "unblockMe",
        "outputs": [
          {
            "name": "",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "totalRewardToken",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "actualBalance",
        "outputs": [
          {
            "name": "_actualBalance",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "closingTime",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "name": "allowedRecipients",
        "outputs": [
          {
            "name": "",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_to",
            "type": "address"
          },
          {
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "transferWithoutReward",
        "outputs": [
          {
            "name": "success",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [],
        "name": "refund",
        "outputs": [],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_recipient",
            "type": "address"
          },
          {
            "name": "_amount",
            "type": "uint256"
          },
          {
            "name": "_description",
            "type": "string"
          },
          {
            "name": "_transactionData",
            "type": "bytes"
          },
          {
            "name": "_debatingPeriod",
            "type": "uint256"
          },
          {
            "name": "_newCurator",
            "type": "bool"
          }
        ],
        "name": "newProposal",
        "outputs": [
          {
            "name": "_proposalID",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "name": "DAOpaidOut",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "minQuorumDivisor",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_newContract",
            "type": "address"
          }
        ],
        "name": "newContract",
        "outputs": [],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "_owner",
            "type": "address"
          }
        ],
        "name": "balanceOf",
        "outputs": [
          {
            "name": "balance",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_recipient",
            "type": "address"
          },
          {
            "name": "_allowed",
            "type": "bool"
          }
        ],
        "name": "changeAllowedRecipients",
        "outputs": [
          {
            "name": "_success",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [],
        "name": "halveMinQuorum",
        "outputs": [
          {
            "name": "_success",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "name": "paidOut",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_proposalID",
            "type": "uint256"
          },
          {
            "name": "_newCurator",
            "type": "address"
          }
        ],
        "name": "splitDAO",
        "outputs": [
          {
            "name": "_success",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "DAOrewardAccount",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "proposalDeposit",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "numberOfProposals",
        "outputs": [
          {
            "name": "_numberOfProposals",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "lastTimeMinQuorumMet",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_toMembers",
            "type": "bool"
          }
        ],
        "name": "retrieveDAOReward",
        "outputs": [
          {
            "name": "_success",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [],
        "name": "receiveEther",
        "outputs": [
          {
            "name": "",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_to",
            "type": "address"
          },
          {
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "transfer",
        "outputs": [
          {
            "name": "success",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "isFueled",
        "outputs": [
          {
            "name": "",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_tokenHolder",
            "type": "address"
          }
        ],
        "name": "createTokenProxy",
        "outputs": [
          {
            "name": "success",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "_proposalID",
            "type": "uint256"
          }
        ],
        "name": "getNewDAOAddress",
        "outputs": [
          {
            "name": "_newDAO",
            "type": "address"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_proposalID",
            "type": "uint256"
          },
          {
            "name": "_supportsProposal",
            "type": "bool"
          }
        ],
        "name": "vote",
        "outputs": [
          {
            "name": "_voteID",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [],
        "name": "getMyReward",
        "outputs": [
          {
            "name": "_success",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "name": "rewardToken",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_from",
            "type": "address"
          },
          {
            "name": "_to",
            "type": "address"
          },
          {
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "transferFromWithoutReward",
        "outputs": [
          {
            "name": "success",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "_owner",
            "type": "address"
          },
          {
            "name": "_spender",
            "type": "address"
          }
        ],
        "name": "allowance",
        "outputs": [
          {
            "name": "remaining",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_proposalDeposit",
            "type": "uint256"
          }
        ],
        "name": "changeProposalDeposit",
        "outputs": [],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "name": "blocked",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "curator",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "_proposalID",
            "type": "uint256"
          },
          {
            "name": "_recipient",
            "type": "address"
          },
          {
            "name": "_amount",
            "type": "uint256"
          },
          {
            "name": "_transactionData",
            "type": "bytes"
          }
        ],
        "name": "checkProposalCode",
        "outputs": [
          {
            "name": "_codeChecksOut",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "privateCreation",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "type": "function"
      },
      {
        "inputs": [
          {
            "name": "_curator",
            "type": "address"
          },
          {
            "name": "_daoCreator",
            "type": "address"
          },
          {
            "name": "_proposalDeposit",
            "type": "uint256"
          },
          {
            "name": "_minTokensToCreate",
            "type": "uint256"
          },
          {
            "name": "_closingTime",
            "type": "uint256"
          },
          {
            "name": "_privateCreation",
            "type": "address"
          }
        ],
        "type": "constructor"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "_from",
            "type": "address"
          },
          {
            "indexed": true,
            "name": "_to",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_amount",
            "type": "uint256"
          }
        ],
        "name": "Transfer",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "_owner",
            "type": "address"
          },
          {
            "indexed": true,
            "name": "_spender",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_amount",
            "type": "uint256"
          }
        ],
        "name": "Approval",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "value",
            "type": "uint256"
          }
        ],
        "name": "FuelingToDate",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "to",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "amount",
            "type": "uint256"
          }
        ],
        "name": "CreatedToken",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "to",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "value",
            "type": "uint256"
          }
        ],
        "name": "Refund",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "proposalID",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "recipient",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "amount",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "newCurator",
            "type": "bool"
          },
          {
            "indexed": false,
            "name": "description",
            "type": "string"
          }
        ],
        "name": "ProposalAdded",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "proposalID",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "position",
            "type": "bool"
          },
          {
            "indexed": true,
            "name": "voter",
            "type": "address"
          }
        ],
        "name": "Voted",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "proposalID",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "result",
            "type": "bool"
          },
          {
            "indexed": false,
            "name": "quorum",
            "type": "uint256"
          }
        ],
        "name": "ProposalTallied",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "_newCurator",
            "type": "address"
          }
        ],
        "name": "NewCurator",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "_recipient",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_allowed",
            "type": "bool"
          }
        ],
        "name": "AllowedRecipientChanged",
        "type": "event"
      }
    ],
    "binary": "606060405260405160c0806133268339610120604052905160805160a051925160e0516101005193949293828282600f829055601083905560118054610100830261010060a860020a031990911617905560405130906001906101be806103408339600160a060020a03909316908301526101408201526040519081900361016001906000f060128054600160a060020a031916919091179055505060038054600160a060020a03199081168917909155600e80549091168717905550600c84905560405130906000906101be806104fe8339018083600160a060020a03168152602001821515815260200192505050604051809103906000f0600760006101000a815481600160a060020a03021916908302179055503060006040516101be806106bc8339018083600160a060020a03168152602001821515815260200192505050604051809103906000f060088054600160a060020a031916919091179055600754600160a060020a03166000141561017957610002565b600854600160a060020a03166000141561019257610002565b426002556005600190815560008054828255829080158290116101ce57600e0281600e0283600052602060002091820191016101ce9190610249565b50505030600160a060020a03908116600090815260046020526040808220805460ff19908116600190811790925560035490941683529120805490921617905550505050505050612aac8061087a6000396000f35b5050600060098201819055600a820155600d81018054600160a060020a0319169055600e015b8082111561033c578054600160a060020a03191681556000600182810182905560028381018054848255909281161561010002600019011604601f81901061030e57505b506000600383018190556004838101805461ffff19169055600584018290556006840182905560078401805460ff191690556008840180548382559083526020909220610223929091028101905b8082111561033c576000808255600182018190556002820155600381018054600160a060020a03191690556004016102db565b601f01602090049060005260206000209081019061028d91905b8082111561033c5760008155600101610328565b50905660606040818152806101be833960a090525160805160008054600160a060020a03191690921760a060020a60ff0219167401000000000000000000000000000000000000000090910217815561016490819061005a90396000f3606060405236156100405760e060020a60003504630221038a811461004d57806318bdc79a146100aa5780638da5cb5b146100be578063d2cc718f146100d0575b6100d96001805434019055565b6100db6004356024356000805433600160a060020a0390811691161415806100755750600034115b806100a05750805460a060020a900460ff1680156100a057508054600160a060020a03848116911614155b156100f957610002565b6100db60005460ff60a060020a9091041681565b6100ef600054600160a060020a031681565b6100ef60015481565b005b604080519115158252519081900360200190f35b6060908152602090f35b600160a060020a0383168260608381818185876185025a03f1925050501561015e57604080518381529051600160a060020a038516917f9735b0cb909f3d21d5c16bbcccd272d85fa11446f6d679f6ecb170d2dabfecfc919081900360200190a25060015b929150505660606040818152806101be833960a090525160805160008054600160a060020a03191690921760a060020a60ff0219167401000000000000000000000000000000000000000090910217815561016490819061005a90396000f3606060405236156100405760e060020a60003504630221038a811461004d57806318bdc79a146100aa5780638da5cb5b146100be578063d2cc718f146100d0575b6100d96001805434019055565b6100db6004356024356000805433600160a060020a0390811691161415806100755750600034115b806100a05750805460a060020a900460ff1680156100a057508054600160a060020a03848116911614155b156100f957610002565b6100db60005460ff60a060020a9091041681565b6100ef600054600160a060020a031681565b6100ef60015481565b005b604080519115158252519081900360200190f35b6060908152602090f35b600160a060020a0383168260608381818185876185025a03f1925050501561015e57604080518381529051600160a060020a038516917f9735b0cb909f3d21d5c16bbcccd272d85fa11446f6d679f6ecb170d2dabfecfc919081900360200190a25060015b929150505660606040818152806101be833960a090525160805160008054600160a060020a03191690921760a060020a60ff0219167401000000000000000000000000000000000000000090910217815561016490819061005a90396000f3606060405236156100405760e060020a60003504630221038a811461004d57806318bdc79a146100aa5780638da5cb5b146100be578063d2cc718f146100d0575b6100d96001805434019055565b6100db6004356024356000805433600160a060020a0390811691161415806100755750600034115b806100a05750805460a060020a900460ff1680156100a057508054600160a060020a03848116911614155b156100f957610002565b6100db60005460ff60a060020a9091041681565b6100ef600054600160a060020a031681565b6100ef60015481565b005b604080519115158252519081900360200190f35b6060908152602090f35b600160a060020a0383168260608381818185876185025a03f1925050501561015e57604080518381529051600160a060020a038516917f9735b0cb909f3d21d5c16bbcccd272d85fa11446f6d679f6ecb170d2dabfecfc919081900360200190a25060015b92915050566060604052361561020e5760e060020a6000350463013cf08b8114610247578063095ea7b3146102d05780630c3b7b96146103455780630e7082031461034e578063149acf9a1461036057806318160ddd146103725780631f2dc5ef1461037b57806321b5b8dd1461039b578063237e9492146103ad57806323b872dd1461040e5780632632bf2014610441578063341458081461047257806339d1f9081461047b5780634b6753bc146104935780634df6d6cc1461049c5780634e10c3ee146104b7578063590e1ae3146104ca578063612e45a3146104db578063643f7cdd1461057a578063674ed066146105925780636837ff1e1461059b57806370a08231146105e5578063749f98891461060b57806378524b2e1461062457806381f03fcb1461067e57806382661dc41461069657806382bf6464146106b75780638b15a605146106c95780638d7af473146106d257806396d7f3f5146106e1578063a1da2fb9146106ea578063a3912ec814610704578063a9059cbb1461070f578063b7bc2c841461073f578063baac53001461074b578063be7c29c1146107b1578063c9d27afe14610817578063cc9ae3f61461082d578063cdef91d014610841578063dbde198814610859578063dd62ed3e1461087e578063e33734fd146108b2578063e5962195146108c6578063e66f53b7146108de578063eceb2945146108f0578063f8c80d261461094f575b610966600f546000906234bc000142108015610239575060125433600160a060020a03908116911614155b1561097a5761098233610752565b6109886004356000805482908110156100025750808052600e8202600080516020612a8c83398151915201905060038101546004820154600683015460018401548454600786015460058701546009880154600a890154600d8a0154600160a060020a039586169b509599600201989760ff81811698610100909204811697949691951693168c565b61096660043560243533600160a060020a03908116600081815260156020908152604080832094871680845294825280832086905580518681529051929493927f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925929181900390910190a35060015b92915050565b610a8960105481565b610a9b600754600160a060020a031681565b610a9b600e54600160a060020a031681565b610a8960165481565b610a895b60004262127500600f60005054031115610bc257506014610985565b610a9b601254600160a060020a031681565b60408051602060248035600481810135601f81018590048502860185019096528585526109669581359591946044949293909201918190840183828082843750949650505050505050600060006000600060006000341115610c3f57610002565b6109666004356024356044355b60115460009060ff1680156104315750600f5442115b801561121c575061121a8461044b565b6109666000610982335b600160a060020a0381166000908152600b6020526040812054819081141561269c57610bb7565b610a8960065481565b610a895b600d5430600160a060020a03163103610985565b610a89600f5481565b61096660043560046020526000908152604090205460ff1681565b610966600435602435600061126b610831565b610ab8600034111561128757610002565b604080516020604435600481810135601f8101849004840285018401909552848452610a89948135946024803595939460649492939101918190840183828082843750506040805160209735808a0135601f81018a90048a0283018a01909352828252969897608497919650602491909101945090925082915084018382808284375094965050933593505060a435915050600060006114c8336105ec565b610a8960043560096020526000908152604090205481565b610a8960015481565b610ab860043530600160a060020a031633600160a060020a03161415806105db5750600160a060020a03811660009081526004602052604090205460ff16155b15611a1257611a0f565b610a896004355b600160a060020a0381166000908152601460205260409020545b919050565b61096660043560243560006000341115611a4357610002565b610966600062e6b680420360026000505410806106505750600354600160a060020a0390811633909116145b80156106645750600254621274ff19420190105b15611ac05750426002908155600180549091028155610985565b610a89600435600a6020526000908152604090205481565b610966600435602435600060006000600060006000341115611ac857610002565b610a9b600854600160a060020a031681565b610a89600c5481565b610a8960005460001901610985565b610a8960025481565b610966600435600060006000600034111561209357610002565b6109665b6001610985565b6109666004356024355b60115460009060ff16801561072f5750600f5442115b801561231557506123133361044b565b61096660115460ff1681565b6109666004355b60006000600f600050544210801561076a5750600034115b80156107a457506011546101009004600160a060020a0316600014806107a457506011546101009004600160a060020a0390811633909116145b15610bbd57610aba61037f565b610a9b600435600060006000508281548110156100025750508080527f290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e56b600e83020180548290811015610002575081526020902060030154600160a060020a0316610606565b610a8960043560243560006000612350336105ec565b6109665b6000600034111561256857610002565b610a8960043560056020526000908152604090205481565b6109666004356024356044356000612571845b60006000600034111561285957610002565b610a89600435602435600160a060020a0382811660009081526015602090815260408083209385168352929052205461033f565b610ab8600435600034111561258757610002565b610a89600435600b6020526000908152604090205481565b610a9b600354600160a060020a031681565b604080516020606435600481810135601f8101849004840285018401909552848452610966948135946024803595604435956084949201919081908401838280828437509496505050505050506000600060003411156125db57610002565b610a9b6011546101009004600160a060020a031681565b604080519115158252519081900360200190f35b610982610708565b90505b90565b604051808d600160a060020a031681526020018c8152602001806020018b81526020018a15158152602001891515815260200188600019168152602001878152602001861515815260200185815260200184815260200183600160a060020a0316815260200182810382528c818154600181600116156101000203166002900481526020019150805460018160011615610100020316600290048015610a6f5780601f10610a4457610100808354040283529160200191610a6f565b820191906000526020600020905b815481529060010190602001808311610a5257829003601f168201915b50509d505050505050505050505050505060405180910390f35b60408051918252519081900360200190f35b60408051600160a060020a03929092168252519081900360200190f35b005b604051601254601434908102939093049350600160a060020a03169183900390600081818185876185025a03f150505050600160a060020a038316600081815260146020908152604080832080548601905560168054860190556013825291829020805434019055815184815291517fdbccb92686efceafb9bb7e0394df7f58f71b954061b81afb57109bf247d3d75a9281900390910190a260105460165410801590610b6a575060115460ff16155b15610bb2576011805460ff1916600117905560165460408051918252517ff381a3e2428fdda36615919e8d9c35878d9eb0cf85ac6edf575088e80e4c147e9181900360200190a15b600191505b50919050565b610002565b4262054600600f60005054031115610bf0576201518062127500600f60005054034203046014019050610985565b50601e610985565b60408051861515815260208101839052815189927fdfc78bdca8e3e0b18c16c5c99323c6cb9eb5e00afde190b4e7273f5158702b07928290030190a25b5050505092915050565b6000805488908110156100025750808052600e8802600080516020612a8c833981519152019050600781015490945060ff16610c7e57620d2f00610c83565b622398805b600485015490935060ff168015610c9f57506003840154830142115b15610cad57610d5787610e2f565b6003840154421080610cc45750600484015460ff16155b80610d4d57508360000160009054906101000a9004600160a060020a03168460010160005054876040518084600160a060020a0316606060020a0281526014018381526020018280519060200190808383829060006004602084601f0104600f02600301f150905001935050505060405180910390206000191684600501600050546000191614155b15610e8457610002565b610c35565b60048401805461ff001916610100179055835460019550600160a060020a039081163090911614801590610da057508354600754600160a060020a03908116911614155b8015610dbc57506008548454600160a060020a03908116911614155b8015610dd857508354601254600160a060020a03908116911614155b8015610df457508354600354600160a060020a03908116911614155b15610e2a5760018401805430600160a060020a031660009081526005602052604090208054919091019055546006805490910190555b610bf8875b6000600060005082815481101561000257908052600e02600080516020612a8c833981519152018150600481015490915060ff1615610e7657600d80546006830154900390555b600401805460ff1916905550565b8354610f3690600160a060020a03165b600160a060020a03811660009081526004602052604081205460ff1680610f295750601254600160a060020a03908116908316148015610f295750601260009054906101000a9004600160a060020a0316600160a060020a031663d2cc718f6040518160e060020a0281526004018090506020604051808303816000876161da5a03f115610002575050604051516006541190505b1561267257506001610606565b1515610f4557610f5187610e2f565b60019150610f8261047f565b604051600d8501546006860154600160a060020a0391909116916000919082818181858883f1935050505050610c35565b60018501541115610f9257600091505b50600a8301546009840154865191019060049010801590610fe1575085600081518110156100025790602001015160f860020a900460f860020a02600160f860020a031916606860f860020a02145b801561101b575085600181518110156100025790602001015160f860020a900460f860020a02600160f860020a031916603760f860020a02145b8015611055575085600281518110156100025790602001015160f860020a900460f860020a02600160f860020a03191660ff60f860020a02145b801561108f575085600381518110156100025790602001015160f860020a900460f860020a02600160f860020a031916601e60f860020a02145b80156110be575030600160a060020a03166000908152600560205260409020546110bb906110d661047f565b81105b156110c857600091505b60018401546110f9906110d8565b015b30600160a060020a031660009081526005602052604081205461267a61047f565b811061114d57604051600d8501546006860154600160a060020a0391909116916000919082818181858883f19350505050151561113557610002565b426002556016546005900481111561114d5760056001555b600184015461115b906110d8565b81101580156111715750600a8401546009850154115b801561117a5750815b15610e2a578360000160009054906101000a9004600160a060020a0316600160a060020a0316846001016000505487604051808280519060200190808383829060006004602084601f0104600f02600301f150905090810190601f1680156111f65780820380516001836020036101000a031916815260200191505b5091505060006040518083038185876185025a03f1925050501515610d5c57610002565b155b801561123757506112378484845b60006000612707856105ec565b801561125457506112548484846000600034111561276e57610002565b15610bbd57506001611264565b90505b9392505050565b151561127657610002565b6112808383610719565b905061033f565b600f544211801561129b575060115460ff16155b156114c657601260009054906101000a9004600160a060020a0316600160a060020a031663d2cc718f6040518160e060020a0281526004018090506020604051808303816000876161da5a03f1156100025750506040516012549051600160a060020a0391909116311090506113ac576040805160125460e060020a63d2cc718f0282529151600160a060020a039290921691630221038a913091849163d2cc718f91600482810192602092919082900301816000876161da5a03f11561000257505060408051805160e160020a63011081c5028252600160a060020a039490941660048201526024810193909352516044838101936020935082900301816000876161da5a03f115610002575050505b33600160a060020a0316600081815260136020526040808220549051909181818185876185025a03f192505050156114c65733600160a060020a03167fbb28353e4598c3b9199101a66e0989549b659a59a54d2c27fbb183f1932c8e6d6013600050600033600160a060020a03168152602001908152602001600020600050546040518082815260200191505060405180910390a26014600050600033600160a060020a0316815260200190815260200160002060005054601660008282825054039250508190555060006014600050600033600160a060020a031681526020019081526020016000206000508190555060006013600050600033600160a060020a03168152602001908152602001600020600050819055505b565b600014156114d557610002565b82801561151f57508660001415806114ef57508451600014155b806115075750600354600160a060020a038981169116145b806115125750600034115b8061151f575062093a8084105b1561152957610002565b82158015611549575061153b88610e94565b158061154957506212750084105b1561155357610002565b6249d40084111561156357610002565b60115460ff1615806115765750600f5442105b8061158b5750600c543410801561158b575082155b1561159557610002565b4284420110156115a457610002565b30600160a060020a031633600160a060020a031614156115c357610002565b60008054600181018083559091908280158290116115fa57600e0281600e0283600052602060002091820191016115fa91906116bf565b505060008054929450918491508110156100025750808052600e8302600080516020612a8c8339815191520190508054600160a060020a031916891781556001818101899055875160028084018054600082815260209081902096975091959481161561010002600019011691909104601f908101829004840193918b01908390106117b657805160ff19168380011785555b506117e692915061179e565b5050600060098201819055600a820155600d81018054600160a060020a0319169055600e015b808211156117b2578054600160a060020a03191681556000600182810182905560028084018054848255909281161561010002600019011604601f81901061178457505b506000600383018190556004808401805461ffff19169055600584018290556006840182905560078401805460ff191690556008840180548382559083526020909220611699929091028101905b808211156117b2576000808255600182018190556002820155600381018054600160a060020a0319169055600401611751565b601f01602090049060005260206000209081019061170391905b808211156117b2576000815560010161179e565b5090565b8280016001018555821561168d579182015b8281111561168d5782518260005055916020019190600101906117c8565b50508787866040518084600160a060020a0316606060020a0281526014018381526020018280519060200190808383829060006004602084601f0104600f02600301f150905001935050505060405180910390208160050160005081905550834201816003016000508190555060018160040160006101000a81548160ff02191690830217905550828160070160006101000a81548160ff0219169083021790555082156118cc57600881018054600181018083559091908280158290116118c7576004028160040283600052602060002091820191016118c79190611751565b505050505b600d8082018054600160a060020a031916331790553460068301819055815401905560408051600160a060020a038a16815260208181018a905285151592820192909252608060608201818152895191830191909152885185937f5790de2c279e58269b93b12828f56fd5f2bc8ad15e61ce08572585c81a38756f938d938d938a938e93929160a084019185810191908190849082908590600090600490601f850104600f02600301f150905090810190601f1680156119a05780820380516001836020036101000a031916815260200191505b509550505050505060405180910390a2509695505050505050565b30600160a060020a0390811660008181526005602090815260408083208054958716808552828520805490970190965584845283905560099091528082208054948352908220805490940190935590815290555b50565b604051600160a060020a0382811691309091163190600081818185876185025a03f19250505015156119bb57610002565b600354600160a060020a039081163390911614611a5f57610002565b600160a060020a038316600081815260046020908152604091829020805460ff1916861790558151851515815291517f73ad2a153c8b67991df9459024950b318a609782cee8c7eeda47b905f9baa91f9281900390910190a250600161033f565b506000610985565b611ad1336105ec565b60001415611ade57610002565b60008054889081101561000257508052600e87027f290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e566810154600080516020612a8c833981519152919091019450421080611b4057506003840154622398800142115b80611b5957508354600160a060020a0390811690871614155b80611b695750600784015460ff16155b80611b8f575033600160a060020a03166000908152600b8501602052604090205460ff16155b80611bc3575033600160a060020a03166000908152600b60205260409020548714801590611bc35750604060009081205414155b15611bcd57610002565b600884018054600090811015610002579081526020812060030154600160a060020a03161415611d3957611e1c86604051600090600160a060020a038316907f9046fefd66f538ab35263248a44217dcb70e2eb2cd136629e141b8b8f9f03b60908390a260408051600e547fe2faf044000000000000000000000000000000000000000000000000000000008252600160a060020a03858116600484015260248301859052604483018590526223988042016064840152925192169163e2faf04491608480820192602092909190829003018187876161da5a03f1156100025750506040515191506106069050565b6008850180546000908110156100025781815260208082209390935530600160a060020a031681526005909252604082205481549092908110156100025790815260208120905060020155601654600885018054600090811015610002579081526020812090506001015560048401805461ff0019166101001790555b6008840180546000908110156100025781548282526020822060010154929190811015610002579081526020812090505433600160a060020a031660009081526014602052604081205460088801805493909102939093049550908110156100025790815260208120905060030160009054906101000a9004600160a060020a0316600160a060020a031663baac530084336040518360e060020a0281526004018082600160a060020a0316815260200191505060206040518083038185886185025a03f115610002575050604051511515600014159150611e98905057610002565b60088501805460009081101561000257818152602081206003018054600160a060020a03191690931790925580549091908110156100025790815260208120905060030154600160a060020a031660001415611e7757610002565b600d5430600160a060020a0316311015611e9057610002565b611cbc61047f565b6008840180546000908110156100025781548282526020822060010154929190811015610002579081526020812090506002015433600160a060020a0390811660009081526014602090815260408083205430909416835260058083528184205460099093529083205460088b018054969095029690960497509487020494508593929091908290811015610002575260208120815060030154600160a060020a03908116825260208281019390935260409182016000908120805490950190945530168352600590915290205482901015611f7357610002565b30600160a060020a031660009081526005602052604081208054849003905560088501805483926009929091829081101561000257508152602080822060030154600160a060020a03908116835292905260408082208054909401909355309091168152205481901015611fe657610002565b30600160a060020a03908116600090815260096020908152604080832080548690039055339093168083526014825283518484205481529351929390927fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef929181900390910190a36120573361086c565b5033600160a060020a03166000908152601460209081526040808320805460168054919091039055839055600a90915281205560019450610c35565b33600160a060020a03818116600090815260096020908152604080832054815160065460085460e060020a63d2cc718f028352935197995091969195929092169363d2cc718f936004848101949193929183900301908290876161da5a03f11561000257505050604051805190602001506005600050600033600160a060020a03168152602001908152602001600020600050540204101561213457610002565b600160a060020a03338116600090815260096020908152604080832054815160065460085460e060020a63d2cc718f02835293519296909593169363d2cc718f93600483810194929383900301908290876161da5a03f11561000257505050604051805190602001506005600050600033600160a060020a03168152602001908152602001600020600050540204039050831561228357600860009054906101000a9004600160a060020a0316600160a060020a0316630221038a83600160a060020a0316630e7082036040518160e060020a0281526004018090506020604051808303816000876161da5a03f11561000257505060408051805160e160020a63011081c5028252600160a060020a031660048201526024810186905290516044808301935060209282900301816000876161da5a03f11561000257505060405151151590506122eb57610002565b6040805160085460e160020a63011081c5028252600160a060020a038581166004840152602483018590529251921691630221038a9160448082019260209290919082900301816000876161da5a03f11561000257505060405151151590506122eb57610002565b600160a060020a03331660009081526009602052604090208054909101905550600192915050565b155b8015612327575061232733848461122a565b801561234357506123438383600060003411156129e757610002565b15610bbd5750600161033f565b6000141561235d57610002565b600034111561236b57610002565b6000805485908110156100025750600160a060020a0333168152600e85027f290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e56e8101602052604090912054600080516020612a8c83398151915291909101915060ff16806123e45750600c810160205260406000205460ff165b806123f3575060038101544210155b156123fd57610002565b82156124435733600160a060020a03166000908152601460209081526040808320546009850180549091019055600b84019091529020805460ff1916600117905561247f565b33600160a060020a0316600090815260146020908152604080832054600a850180549091019055600c84019091529020805460ff191660011790555b33600160a060020a03166000908152600b602052604081205414156124ab57604060002084905561251f565b33600160a060020a03166000908152600b60205260408120548154811015610002579080527f290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e566600e90910201546003820154111561251f5733600160a060020a03166000908152600b602052604090208490555b604080518415158152905133600160a060020a03169186917f86abfce99b7dd908bec0169288797f85049ec73cbe046ed9de818fab3a497ae09181900360200190a35092915050565b6109823361086c565b151561257c57610002565b61126184848461041b565b30600160a060020a031633600160a060020a03161415806125cc575030600160a060020a03166000908152600560205260409020546064906125c761047f565b010481115b156125d657610002565b600c55565b6000805487908110156100025750808052600e8702600080516020612a8c83398151915201905090508484846040518084600160a060020a0316606060020a0281526014018381526020018280519060200190808383829060006004602084601f0104600f02600301f150905001935050505060405180910390206000191681600501600050546000191614915050949350505050565b506000610606565b0160030260166000505483020460016000505460166000505404019050610606565b600160a060020a0383166000908152600b6020526040812054815481101561000257818052600e02600080516020612a8c8339815191520190506003810154909150421115610bb257600160a060020a0383166000908152600b602052604081208190559150610bb7565b600160a060020a0386166000908152600a602052604090205480850291909104915081111561273557610002565b600160a060020a038581166000908152600a60205260408082208054859003905591861681522080548201905560019150509392505050565b600160a060020a0384166000908152601460205260409020548290108015906127b75750601560209081526040600081812033600160a060020a03168252909252902054829010155b80156127c35750600082115b1561285157600160a060020a03838116600081815260146020908152604080832080548801905588851680845281842080548990039055601583528184203390961684529482529182902080548790039055815186815291519293927fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9281900390910190a3506001611264565b506000611264565b600160a060020a038381166000908152600a6020908152604080832054601654600754835160e060020a63d2cc718f02815293519296919591169363d2cc718f9360048181019492939183900301908290876161da5a03f1156100025750506040515190506128c7866105ec565b020410156128d457610002565b600160a060020a038381166000908152600a6020908152604080832054601654600754835160e060020a63d2cc718f02815293519296919591169363d2cc718f9360048181019492939183900301908290876161da5a03f115610002575050604051519050612942866105ec565b0204039050600760009054906101000a9004600160a060020a0316600160a060020a0316630221038a84836040518360e060020a0281526004018083600160a060020a03168152602001828152602001925050506020604051808303816000876161da5a03f11561000257505060405151151590506129c057610002565b600160a060020a0383166000908152600a6020526040902080548201905560019150610bb7565b33600160a060020a0316600090815260146020526040902054829010801590612a105750600082115b15612a8457600160a060020a03338116600081815260146020908152604080832080548890039055938716808352918490208054870190558351868152935191937fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef929081900390910190a350600161033f565b50600061033f56290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563",
    "unlinked_binary": "606060405260405160c0806133268339610120604052905160805160a051925160e0516101005193949293828282600f829055601083905560118054610100830261010060a860020a031990911617905560405130906001906101be806103408339600160a060020a03909316908301526101408201526040519081900361016001906000f060128054600160a060020a031916919091179055505060038054600160a060020a03199081168917909155600e80549091168717905550600c84905560405130906000906101be806104fe8339018083600160a060020a03168152602001821515815260200192505050604051809103906000f0600760006101000a815481600160a060020a03021916908302179055503060006040516101be806106bc8339018083600160a060020a03168152602001821515815260200192505050604051809103906000f060088054600160a060020a031916919091179055600754600160a060020a03166000141561017957610002565b600854600160a060020a03166000141561019257610002565b426002556005600190815560008054828255829080158290116101ce57600e0281600e0283600052602060002091820191016101ce9190610249565b50505030600160a060020a03908116600090815260046020526040808220805460ff19908116600190811790925560035490941683529120805490921617905550505050505050612aac8061087a6000396000f35b5050600060098201819055600a820155600d81018054600160a060020a0319169055600e015b8082111561033c578054600160a060020a03191681556000600182810182905560028381018054848255909281161561010002600019011604601f81901061030e57505b506000600383018190556004838101805461ffff19169055600584018290556006840182905560078401805460ff191690556008840180548382559083526020909220610223929091028101905b8082111561033c576000808255600182018190556002820155600381018054600160a060020a03191690556004016102db565b601f01602090049060005260206000209081019061028d91905b8082111561033c5760008155600101610328565b50905660606040818152806101be833960a090525160805160008054600160a060020a03191690921760a060020a60ff0219167401000000000000000000000000000000000000000090910217815561016490819061005a90396000f3606060405236156100405760e060020a60003504630221038a811461004d57806318bdc79a146100aa5780638da5cb5b146100be578063d2cc718f146100d0575b6100d96001805434019055565b6100db6004356024356000805433600160a060020a0390811691161415806100755750600034115b806100a05750805460a060020a900460ff1680156100a057508054600160a060020a03848116911614155b156100f957610002565b6100db60005460ff60a060020a9091041681565b6100ef600054600160a060020a031681565b6100ef60015481565b005b604080519115158252519081900360200190f35b6060908152602090f35b600160a060020a0383168260608381818185876185025a03f1925050501561015e57604080518381529051600160a060020a038516917f9735b0cb909f3d21d5c16bbcccd272d85fa11446f6d679f6ecb170d2dabfecfc919081900360200190a25060015b929150505660606040818152806101be833960a090525160805160008054600160a060020a03191690921760a060020a60ff0219167401000000000000000000000000000000000000000090910217815561016490819061005a90396000f3606060405236156100405760e060020a60003504630221038a811461004d57806318bdc79a146100aa5780638da5cb5b146100be578063d2cc718f146100d0575b6100d96001805434019055565b6100db6004356024356000805433600160a060020a0390811691161415806100755750600034115b806100a05750805460a060020a900460ff1680156100a057508054600160a060020a03848116911614155b156100f957610002565b6100db60005460ff60a060020a9091041681565b6100ef600054600160a060020a031681565b6100ef60015481565b005b604080519115158252519081900360200190f35b6060908152602090f35b600160a060020a0383168260608381818185876185025a03f1925050501561015e57604080518381529051600160a060020a038516917f9735b0cb909f3d21d5c16bbcccd272d85fa11446f6d679f6ecb170d2dabfecfc919081900360200190a25060015b929150505660606040818152806101be833960a090525160805160008054600160a060020a03191690921760a060020a60ff0219167401000000000000000000000000000000000000000090910217815561016490819061005a90396000f3606060405236156100405760e060020a60003504630221038a811461004d57806318bdc79a146100aa5780638da5cb5b146100be578063d2cc718f146100d0575b6100d96001805434019055565b6100db6004356024356000805433600160a060020a0390811691161415806100755750600034115b806100a05750805460a060020a900460ff1680156100a057508054600160a060020a03848116911614155b156100f957610002565b6100db60005460ff60a060020a9091041681565b6100ef600054600160a060020a031681565b6100ef60015481565b005b604080519115158252519081900360200190f35b6060908152602090f35b600160a060020a0383168260608381818185876185025a03f1925050501561015e57604080518381529051600160a060020a038516917f9735b0cb909f3d21d5c16bbcccd272d85fa11446f6d679f6ecb170d2dabfecfc919081900360200190a25060015b92915050566060604052361561020e5760e060020a6000350463013cf08b8114610247578063095ea7b3146102d05780630c3b7b96146103455780630e7082031461034e578063149acf9a1461036057806318160ddd146103725780631f2dc5ef1461037b57806321b5b8dd1461039b578063237e9492146103ad57806323b872dd1461040e5780632632bf2014610441578063341458081461047257806339d1f9081461047b5780634b6753bc146104935780634df6d6cc1461049c5780634e10c3ee146104b7578063590e1ae3146104ca578063612e45a3146104db578063643f7cdd1461057a578063674ed066146105925780636837ff1e1461059b57806370a08231146105e5578063749f98891461060b57806378524b2e1461062457806381f03fcb1461067e57806382661dc41461069657806382bf6464146106b75780638b15a605146106c95780638d7af473146106d257806396d7f3f5146106e1578063a1da2fb9146106ea578063a3912ec814610704578063a9059cbb1461070f578063b7bc2c841461073f578063baac53001461074b578063be7c29c1146107b1578063c9d27afe14610817578063cc9ae3f61461082d578063cdef91d014610841578063dbde198814610859578063dd62ed3e1461087e578063e33734fd146108b2578063e5962195146108c6578063e66f53b7146108de578063eceb2945146108f0578063f8c80d261461094f575b610966600f546000906234bc000142108015610239575060125433600160a060020a03908116911614155b1561097a5761098233610752565b6109886004356000805482908110156100025750808052600e8202600080516020612a8c83398151915201905060038101546004820154600683015460018401548454600786015460058701546009880154600a890154600d8a0154600160a060020a039586169b509599600201989760ff81811698610100909204811697949691951693168c565b61096660043560243533600160a060020a03908116600081815260156020908152604080832094871680845294825280832086905580518681529051929493927f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925929181900390910190a35060015b92915050565b610a8960105481565b610a9b600754600160a060020a031681565b610a9b600e54600160a060020a031681565b610a8960165481565b610a895b60004262127500600f60005054031115610bc257506014610985565b610a9b601254600160a060020a031681565b60408051602060248035600481810135601f81018590048502860185019096528585526109669581359591946044949293909201918190840183828082843750949650505050505050600060006000600060006000341115610c3f57610002565b6109666004356024356044355b60115460009060ff1680156104315750600f5442115b801561121c575061121a8461044b565b6109666000610982335b600160a060020a0381166000908152600b6020526040812054819081141561269c57610bb7565b610a8960065481565b610a895b600d5430600160a060020a03163103610985565b610a89600f5481565b61096660043560046020526000908152604090205460ff1681565b610966600435602435600061126b610831565b610ab8600034111561128757610002565b604080516020604435600481810135601f8101849004840285018401909552848452610a89948135946024803595939460649492939101918190840183828082843750506040805160209735808a0135601f81018a90048a0283018a01909352828252969897608497919650602491909101945090925082915084018382808284375094965050933593505060a435915050600060006114c8336105ec565b610a8960043560096020526000908152604090205481565b610a8960015481565b610ab860043530600160a060020a031633600160a060020a03161415806105db5750600160a060020a03811660009081526004602052604090205460ff16155b15611a1257611a0f565b610a896004355b600160a060020a0381166000908152601460205260409020545b919050565b61096660043560243560006000341115611a4357610002565b610966600062e6b680420360026000505410806106505750600354600160a060020a0390811633909116145b80156106645750600254621274ff19420190105b15611ac05750426002908155600180549091028155610985565b610a89600435600a6020526000908152604090205481565b610966600435602435600060006000600060006000341115611ac857610002565b610a9b600854600160a060020a031681565b610a89600c5481565b610a8960005460001901610985565b610a8960025481565b610966600435600060006000600034111561209357610002565b6109665b6001610985565b6109666004356024355b60115460009060ff16801561072f5750600f5442115b801561231557506123133361044b565b61096660115460ff1681565b6109666004355b60006000600f600050544210801561076a5750600034115b80156107a457506011546101009004600160a060020a0316600014806107a457506011546101009004600160a060020a0390811633909116145b15610bbd57610aba61037f565b610a9b600435600060006000508281548110156100025750508080527f290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e56b600e83020180548290811015610002575081526020902060030154600160a060020a0316610606565b610a8960043560243560006000612350336105ec565b6109665b6000600034111561256857610002565b610a8960043560056020526000908152604090205481565b6109666004356024356044356000612571845b60006000600034111561285957610002565b610a89600435602435600160a060020a0382811660009081526015602090815260408083209385168352929052205461033f565b610ab8600435600034111561258757610002565b610a89600435600b6020526000908152604090205481565b610a9b600354600160a060020a031681565b604080516020606435600481810135601f8101849004840285018401909552848452610966948135946024803595604435956084949201919081908401838280828437509496505050505050506000600060003411156125db57610002565b610a9b6011546101009004600160a060020a031681565b604080519115158252519081900360200190f35b610982610708565b90505b90565b604051808d600160a060020a031681526020018c8152602001806020018b81526020018a15158152602001891515815260200188600019168152602001878152602001861515815260200185815260200184815260200183600160a060020a0316815260200182810382528c818154600181600116156101000203166002900481526020019150805460018160011615610100020316600290048015610a6f5780601f10610a4457610100808354040283529160200191610a6f565b820191906000526020600020905b815481529060010190602001808311610a5257829003601f168201915b50509d505050505050505050505050505060405180910390f35b60408051918252519081900360200190f35b60408051600160a060020a03929092168252519081900360200190f35b005b604051601254601434908102939093049350600160a060020a03169183900390600081818185876185025a03f150505050600160a060020a038316600081815260146020908152604080832080548601905560168054860190556013825291829020805434019055815184815291517fdbccb92686efceafb9bb7e0394df7f58f71b954061b81afb57109bf247d3d75a9281900390910190a260105460165410801590610b6a575060115460ff16155b15610bb2576011805460ff1916600117905560165460408051918252517ff381a3e2428fdda36615919e8d9c35878d9eb0cf85ac6edf575088e80e4c147e9181900360200190a15b600191505b50919050565b610002565b4262054600600f60005054031115610bf0576201518062127500600f60005054034203046014019050610985565b50601e610985565b60408051861515815260208101839052815189927fdfc78bdca8e3e0b18c16c5c99323c6cb9eb5e00afde190b4e7273f5158702b07928290030190a25b5050505092915050565b6000805488908110156100025750808052600e8802600080516020612a8c833981519152019050600781015490945060ff16610c7e57620d2f00610c83565b622398805b600485015490935060ff168015610c9f57506003840154830142115b15610cad57610d5787610e2f565b6003840154421080610cc45750600484015460ff16155b80610d4d57508360000160009054906101000a9004600160a060020a03168460010160005054876040518084600160a060020a0316606060020a0281526014018381526020018280519060200190808383829060006004602084601f0104600f02600301f150905001935050505060405180910390206000191684600501600050546000191614155b15610e8457610002565b610c35565b60048401805461ff001916610100179055835460019550600160a060020a039081163090911614801590610da057508354600754600160a060020a03908116911614155b8015610dbc57506008548454600160a060020a03908116911614155b8015610dd857508354601254600160a060020a03908116911614155b8015610df457508354600354600160a060020a03908116911614155b15610e2a5760018401805430600160a060020a031660009081526005602052604090208054919091019055546006805490910190555b610bf8875b6000600060005082815481101561000257908052600e02600080516020612a8c833981519152018150600481015490915060ff1615610e7657600d80546006830154900390555b600401805460ff1916905550565b8354610f3690600160a060020a03165b600160a060020a03811660009081526004602052604081205460ff1680610f295750601254600160a060020a03908116908316148015610f295750601260009054906101000a9004600160a060020a0316600160a060020a031663d2cc718f6040518160e060020a0281526004018090506020604051808303816000876161da5a03f115610002575050604051516006541190505b1561267257506001610606565b1515610f4557610f5187610e2f565b60019150610f8261047f565b604051600d8501546006860154600160a060020a0391909116916000919082818181858883f1935050505050610c35565b60018501541115610f9257600091505b50600a8301546009840154865191019060049010801590610fe1575085600081518110156100025790602001015160f860020a900460f860020a02600160f860020a031916606860f860020a02145b801561101b575085600181518110156100025790602001015160f860020a900460f860020a02600160f860020a031916603760f860020a02145b8015611055575085600281518110156100025790602001015160f860020a900460f860020a02600160f860020a03191660ff60f860020a02145b801561108f575085600381518110156100025790602001015160f860020a900460f860020a02600160f860020a031916601e60f860020a02145b80156110be575030600160a060020a03166000908152600560205260409020546110bb906110d661047f565b81105b156110c857600091505b60018401546110f9906110d8565b015b30600160a060020a031660009081526005602052604081205461267a61047f565b811061114d57604051600d8501546006860154600160a060020a0391909116916000919082818181858883f19350505050151561113557610002565b426002556016546005900481111561114d5760056001555b600184015461115b906110d8565b81101580156111715750600a8401546009850154115b801561117a5750815b15610e2a578360000160009054906101000a9004600160a060020a0316600160a060020a0316846001016000505487604051808280519060200190808383829060006004602084601f0104600f02600301f150905090810190601f1680156111f65780820380516001836020036101000a031916815260200191505b5091505060006040518083038185876185025a03f1925050501515610d5c57610002565b155b801561123757506112378484845b60006000612707856105ec565b801561125457506112548484846000600034111561276e57610002565b15610bbd57506001611264565b90505b9392505050565b151561127657610002565b6112808383610719565b905061033f565b600f544211801561129b575060115460ff16155b156114c657601260009054906101000a9004600160a060020a0316600160a060020a031663d2cc718f6040518160e060020a0281526004018090506020604051808303816000876161da5a03f1156100025750506040516012549051600160a060020a0391909116311090506113ac576040805160125460e060020a63d2cc718f0282529151600160a060020a039290921691630221038a913091849163d2cc718f91600482810192602092919082900301816000876161da5a03f11561000257505060408051805160e160020a63011081c5028252600160a060020a039490941660048201526024810193909352516044838101936020935082900301816000876161da5a03f115610002575050505b33600160a060020a0316600081815260136020526040808220549051909181818185876185025a03f192505050156114c65733600160a060020a03167fbb28353e4598c3b9199101a66e0989549b659a59a54d2c27fbb183f1932c8e6d6013600050600033600160a060020a03168152602001908152602001600020600050546040518082815260200191505060405180910390a26014600050600033600160a060020a0316815260200190815260200160002060005054601660008282825054039250508190555060006014600050600033600160a060020a031681526020019081526020016000206000508190555060006013600050600033600160a060020a03168152602001908152602001600020600050819055505b565b600014156114d557610002565b82801561151f57508660001415806114ef57508451600014155b806115075750600354600160a060020a038981169116145b806115125750600034115b8061151f575062093a8084105b1561152957610002565b82158015611549575061153b88610e94565b158061154957506212750084105b1561155357610002565b6249d40084111561156357610002565b60115460ff1615806115765750600f5442105b8061158b5750600c543410801561158b575082155b1561159557610002565b4284420110156115a457610002565b30600160a060020a031633600160a060020a031614156115c357610002565b60008054600181018083559091908280158290116115fa57600e0281600e0283600052602060002091820191016115fa91906116bf565b505060008054929450918491508110156100025750808052600e8302600080516020612a8c8339815191520190508054600160a060020a031916891781556001818101899055875160028084018054600082815260209081902096975091959481161561010002600019011691909104601f908101829004840193918b01908390106117b657805160ff19168380011785555b506117e692915061179e565b5050600060098201819055600a820155600d81018054600160a060020a0319169055600e015b808211156117b2578054600160a060020a03191681556000600182810182905560028084018054848255909281161561010002600019011604601f81901061178457505b506000600383018190556004808401805461ffff19169055600584018290556006840182905560078401805460ff191690556008840180548382559083526020909220611699929091028101905b808211156117b2576000808255600182018190556002820155600381018054600160a060020a0319169055600401611751565b601f01602090049060005260206000209081019061170391905b808211156117b2576000815560010161179e565b5090565b8280016001018555821561168d579182015b8281111561168d5782518260005055916020019190600101906117c8565b50508787866040518084600160a060020a0316606060020a0281526014018381526020018280519060200190808383829060006004602084601f0104600f02600301f150905001935050505060405180910390208160050160005081905550834201816003016000508190555060018160040160006101000a81548160ff02191690830217905550828160070160006101000a81548160ff0219169083021790555082156118cc57600881018054600181018083559091908280158290116118c7576004028160040283600052602060002091820191016118c79190611751565b505050505b600d8082018054600160a060020a031916331790553460068301819055815401905560408051600160a060020a038a16815260208181018a905285151592820192909252608060608201818152895191830191909152885185937f5790de2c279e58269b93b12828f56fd5f2bc8ad15e61ce08572585c81a38756f938d938d938a938e93929160a084019185810191908190849082908590600090600490601f850104600f02600301f150905090810190601f1680156119a05780820380516001836020036101000a031916815260200191505b509550505050505060405180910390a2509695505050505050565b30600160a060020a0390811660008181526005602090815260408083208054958716808552828520805490970190965584845283905560099091528082208054948352908220805490940190935590815290555b50565b604051600160a060020a0382811691309091163190600081818185876185025a03f19250505015156119bb57610002565b600354600160a060020a039081163390911614611a5f57610002565b600160a060020a038316600081815260046020908152604091829020805460ff1916861790558151851515815291517f73ad2a153c8b67991df9459024950b318a609782cee8c7eeda47b905f9baa91f9281900390910190a250600161033f565b506000610985565b611ad1336105ec565b60001415611ade57610002565b60008054889081101561000257508052600e87027f290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e566810154600080516020612a8c833981519152919091019450421080611b4057506003840154622398800142115b80611b5957508354600160a060020a0390811690871614155b80611b695750600784015460ff16155b80611b8f575033600160a060020a03166000908152600b8501602052604090205460ff16155b80611bc3575033600160a060020a03166000908152600b60205260409020548714801590611bc35750604060009081205414155b15611bcd57610002565b600884018054600090811015610002579081526020812060030154600160a060020a03161415611d3957611e1c86604051600090600160a060020a038316907f9046fefd66f538ab35263248a44217dcb70e2eb2cd136629e141b8b8f9f03b60908390a260408051600e547fe2faf044000000000000000000000000000000000000000000000000000000008252600160a060020a03858116600484015260248301859052604483018590526223988042016064840152925192169163e2faf04491608480820192602092909190829003018187876161da5a03f1156100025750506040515191506106069050565b6008850180546000908110156100025781815260208082209390935530600160a060020a031681526005909252604082205481549092908110156100025790815260208120905060020155601654600885018054600090811015610002579081526020812090506001015560048401805461ff0019166101001790555b6008840180546000908110156100025781548282526020822060010154929190811015610002579081526020812090505433600160a060020a031660009081526014602052604081205460088801805493909102939093049550908110156100025790815260208120905060030160009054906101000a9004600160a060020a0316600160a060020a031663baac530084336040518360e060020a0281526004018082600160a060020a0316815260200191505060206040518083038185886185025a03f115610002575050604051511515600014159150611e98905057610002565b60088501805460009081101561000257818152602081206003018054600160a060020a03191690931790925580549091908110156100025790815260208120905060030154600160a060020a031660001415611e7757610002565b600d5430600160a060020a0316311015611e9057610002565b611cbc61047f565b6008840180546000908110156100025781548282526020822060010154929190811015610002579081526020812090506002015433600160a060020a0390811660009081526014602090815260408083205430909416835260058083528184205460099093529083205460088b018054969095029690960497509487020494508593929091908290811015610002575260208120815060030154600160a060020a03908116825260208281019390935260409182016000908120805490950190945530168352600590915290205482901015611f7357610002565b30600160a060020a031660009081526005602052604081208054849003905560088501805483926009929091829081101561000257508152602080822060030154600160a060020a03908116835292905260408082208054909401909355309091168152205481901015611fe657610002565b30600160a060020a03908116600090815260096020908152604080832080548690039055339093168083526014825283518484205481529351929390927fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef929181900390910190a36120573361086c565b5033600160a060020a03166000908152601460209081526040808320805460168054919091039055839055600a90915281205560019450610c35565b33600160a060020a03818116600090815260096020908152604080832054815160065460085460e060020a63d2cc718f028352935197995091969195929092169363d2cc718f936004848101949193929183900301908290876161da5a03f11561000257505050604051805190602001506005600050600033600160a060020a03168152602001908152602001600020600050540204101561213457610002565b600160a060020a03338116600090815260096020908152604080832054815160065460085460e060020a63d2cc718f02835293519296909593169363d2cc718f93600483810194929383900301908290876161da5a03f11561000257505050604051805190602001506005600050600033600160a060020a03168152602001908152602001600020600050540204039050831561228357600860009054906101000a9004600160a060020a0316600160a060020a0316630221038a83600160a060020a0316630e7082036040518160e060020a0281526004018090506020604051808303816000876161da5a03f11561000257505060408051805160e160020a63011081c5028252600160a060020a031660048201526024810186905290516044808301935060209282900301816000876161da5a03f11561000257505060405151151590506122eb57610002565b6040805160085460e160020a63011081c5028252600160a060020a038581166004840152602483018590529251921691630221038a9160448082019260209290919082900301816000876161da5a03f11561000257505060405151151590506122eb57610002565b600160a060020a03331660009081526009602052604090208054909101905550600192915050565b155b8015612327575061232733848461122a565b801561234357506123438383600060003411156129e757610002565b15610bbd5750600161033f565b6000141561235d57610002565b600034111561236b57610002565b6000805485908110156100025750600160a060020a0333168152600e85027f290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e56e8101602052604090912054600080516020612a8c83398151915291909101915060ff16806123e45750600c810160205260406000205460ff165b806123f3575060038101544210155b156123fd57610002565b82156124435733600160a060020a03166000908152601460209081526040808320546009850180549091019055600b84019091529020805460ff1916600117905561247f565b33600160a060020a0316600090815260146020908152604080832054600a850180549091019055600c84019091529020805460ff191660011790555b33600160a060020a03166000908152600b602052604081205414156124ab57604060002084905561251f565b33600160a060020a03166000908152600b60205260408120548154811015610002579080527f290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e566600e90910201546003820154111561251f5733600160a060020a03166000908152600b602052604090208490555b604080518415158152905133600160a060020a03169186917f86abfce99b7dd908bec0169288797f85049ec73cbe046ed9de818fab3a497ae09181900360200190a35092915050565b6109823361086c565b151561257c57610002565b61126184848461041b565b30600160a060020a031633600160a060020a03161415806125cc575030600160a060020a03166000908152600560205260409020546064906125c761047f565b010481115b156125d657610002565b600c55565b6000805487908110156100025750808052600e8702600080516020612a8c83398151915201905090508484846040518084600160a060020a0316606060020a0281526014018381526020018280519060200190808383829060006004602084601f0104600f02600301f150905001935050505060405180910390206000191681600501600050546000191614915050949350505050565b506000610606565b0160030260166000505483020460016000505460166000505404019050610606565b600160a060020a0383166000908152600b6020526040812054815481101561000257818052600e02600080516020612a8c8339815191520190506003810154909150421115610bb257600160a060020a0383166000908152600b602052604081208190559150610bb7565b600160a060020a0386166000908152600a602052604090205480850291909104915081111561273557610002565b600160a060020a038581166000908152600a60205260408082208054859003905591861681522080548201905560019150509392505050565b600160a060020a0384166000908152601460205260409020548290108015906127b75750601560209081526040600081812033600160a060020a03168252909252902054829010155b80156127c35750600082115b1561285157600160a060020a03838116600081815260146020908152604080832080548801905588851680845281842080548990039055601583528184203390961684529482529182902080548790039055815186815291519293927fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9281900390910190a3506001611264565b506000611264565b600160a060020a038381166000908152600a6020908152604080832054601654600754835160e060020a63d2cc718f02815293519296919591169363d2cc718f9360048181019492939183900301908290876161da5a03f1156100025750506040515190506128c7866105ec565b020410156128d457610002565b600160a060020a038381166000908152600a6020908152604080832054601654600754835160e060020a63d2cc718f02815293519296919591169363d2cc718f9360048181019492939183900301908290876161da5a03f115610002575050604051519050612942866105ec565b0204039050600760009054906101000a9004600160a060020a0316600160a060020a0316630221038a84836040518360e060020a0281526004018083600160a060020a03168152602001828152602001925050506020604051808303816000876161da5a03f11561000257505060405151151590506129c057610002565b600160a060020a0383166000908152600a6020526040902080548201905560019150610bb7565b33600160a060020a0316600090815260146020526040902054829010801590612a105750600082115b15612a8457600160a060020a03338116600081815260146020908152604080832080548890039055938716808352918490208054870190558351868152935191937fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef929081900390910190a350600161033f565b50600061033f56290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563",
    "updated_at": 1467656954050
  }
};

  Contract.checkNetwork = function(callback) {
    var self = this;

    if (this.network_id != null) {
      return callback();
    }

    this.web3.version.network(function(err, result) {
      if (err) return callback(err);

      var network_id = result.toString();

      // If we have the main network,
      if (network_id == "1") {
        var possible_ids = ["1", "live", "default"];

        for (var i = 0; i < possible_ids.length; i++) {
          var id = possible_ids[i];
          if (Contract.all_networks[id] != null) {
            network_id = id;
            break;
          }
        }
      }

      if (self.all_networks[network_id] == null) {
        return callback(new Error(self.name + " error: Can't find artifacts for network id '" + network_id + "'"));
      }

      self.setNetwork(network_id);
      callback();
    })
  };

  Contract.setNetwork = function(network_id) {
    var network = this.all_networks[network_id] || {};

    this.abi             = this.prototype.abi             = network.abi;
    this.binary          = this.prototype.binary          = network.binary;
    this.unlinked_binary = this.prototype.unlinked_binary = network.unlinked_binary;
    this.address         = this.prototype.address         = network.address;
    this.updated_at      = this.prototype.updated_at      = network.updated_at;

    if (this.unlinked_binary == null || this.unlinked_binary == "") {
      this.unlinked_binary = this.prototype.unlinked_binary = this.binary;
    }

    this.network_id = network_id;
  };

  Contract.networks = function() {
    return Object.keys(this.all_networks);
  };

  Contract.contract_name   = Contract.prototype.contract_name   = "DAO";
  Contract.generated_with  = Contract.prototype.generated_with  = "3.0.3";

  bootstrap(Contract);

  if (typeof module != "undefined" && typeof module.exports != "undefined") {
    module.exports = Contract;
  } else {
    // There will only be one version of this contract in the browser,
    // and we can use that.
    window.DAO = Contract;
  }
})();
