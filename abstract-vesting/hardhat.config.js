require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");

module.exports = {
  solidity: "0.8.20",
  networks: {
    abstract: {
      url: process.env.RPC_ABSTRACT,
      chainId: 2741,
      accounts: [process.env.PRIVATE_KEY].filter(Boolean),
    },
    abstractTestnet: {
      url: process.env.RPC_ABSTRACT_TESTNET,
      chainId: 11124,
      accounts: [process.env.PRIVATE_KEY].filter(Boolean),
    }
  }
};
