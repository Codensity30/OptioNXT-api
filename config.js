require("dotenv").config();

const config = {
  dburi: process.env.Database_URL,
};

module.exports = config;
