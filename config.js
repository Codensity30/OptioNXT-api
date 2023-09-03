require("dotenv").config();

const config = {
  dburi: process.env.Database_URL,
  apiurl: process.env.Api_URL,
};

module.exports = config;
