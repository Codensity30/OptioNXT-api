//! IMPORTING REQUIRED MODULES ---------------------
const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const luxon = require("luxon");
const cors = require("cors");
const config = require("./config");
const bodyParser = require("body-parser");

//* function to handle error
function errorHandler(error) {
  console.log("⚠ Error Ocurred");
  console.log(error);
}

//! INTIALIZING REQUIREMENTS ------------------------

//* connecting to database
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(config.dburi, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.log(error);
    process.exit(1);
  }
};

//* intializing express server

const PORT = process.env.PORT || 8000;
const app = express();

app.use(cors());
app.use(bodyParser.json());

//! MONGOOSE SCHEMA ----------------------------------

//* schema of docs for symbol list
const symbolListSchema = new mongoose.Schema({
  symbolName: String,
  lotSize: Number,
});
//* type of object within the oiArray
const oi = {
  spot: Number,
  time: String,
  putsCoi: Number,
  callsCoi: Number,
};
//* schema of documents for coi change with time
const oiDataSchema = new mongoose.Schema({
  strikePrice: Number,
  oiArray: [oi],
});
const feedbackSchema = new mongoose.Schema({
  name: String,
  email: String,
  message: String,
});

//! DAILY JOBS------------------------------------------

//! important functions to store the and clear db in daily routine

function getCurrentISTTime() {
  const currentTime = new Date();

  const currentOffset = currentTime.getTimezoneOffset();

  const ISTOffset = 330; // IST offset UTC +5:30

  const ISTTime = new Date(
    currentTime.getTime() + (ISTOffset + currentOffset) * 60000
  );

  // ISTTime now represents the time in IST coordinates

  const hoursIST = ISTTime.getHours().toString().padStart(2, "0");
  const minutesIST = ISTTime.getMinutes().toString().padStart(2, "0");

  return `${hoursIST}:${minutesIST}`;
}

function isWithinTradingTime(currentTime) {
  return (
    currentTime.hour >= 9 &&
    currentTime.minute >= 20 &&
    (currentTime.hour < 15 ||
      (currentTime.hour === 15 && currentTime.minute <= 30))
  );
}

function isTradingHoliday(currentDay) {
  const holidays = ["02-10-2023", "14-11-2023", "27-11-2023", "25-12-2023"];
  return holidays.includes(currentDay);
}

async function getAndStore(symbol) {
  const url = "https://webapi.niftytrader.in/webapi/option/fatch-option-chain";

  try {
    const response = await axios.get(url, {
      params: { symbol: symbol },
    });

    if (response) {
      //* creating mongoose model with collection name same as symbol
      const Symbol = mongoose.model(symbol, oiDataSchema, symbol);

      //* parsing response from api to get the option data
      const opDatas = response.data.resultData.opDatas;

      //* important variables required
      const spot = opDatas[0].index_close;

      opDatas.sort((a, b) => {
        return a.strike_price < b.strike_price;
      });

      const atmIndex = opDatas.findIndex((obj) => obj.strike_price > spot);
      let total_puts_change_oi = 0;
      let total_calls_change_oi = 0;

      //* entry of all sp lying in range of 1000 points up and down
      const start = Math.max(0, atmIndex - 20);
      const end = Math.min(opDatas.length - 1, atmIndex + 20);
      for (let i = start; i <= end; i++) {
        const element = opDatas[i];
        const sp = element.strike_price;

        //* summing up coi of 10 strikes up-down
        if (Math.abs(i - atmIndex) <= 10) {
          total_puts_change_oi += element.puts_change_oi;
          total_calls_change_oi += element.calls_change_oi;
        }

        //* storing coi of 20 strikes up-down in db
        const doc = await Symbol.findOne({ strikePrice: sp }).catch(
          errorHandler
        );

        const oiArray = {
          spot: spot,
          time: getCurrentISTTime(),
          putsCoi: element.puts_change_oi,
          callsCoi: element.calls_change_oi,
        };

        if (!doc) {
          await Symbol.create({ strikePrice: sp, oiArray }).catch(errorHandler);
        } else {
          await Symbol.updateOne(
            { strikePrice: sp },
            { $push: { oiArray } }
          ).catch(errorHandler);
        }
      }

      //* special entry to keep track of the total put and call oi
      const doc = await Symbol.findOne({ strikePrice: 0 }).catch(errorHandler);

      const oiArray = {
        spot: spot,
        time: getCurrentISTTime(),
        putsCoi: total_puts_change_oi,
        callsCoi: total_calls_change_oi,
      };

      if (!doc) {
        await Symbol.create({ strikePrice: 0, oiArray }).catch(errorHandler);
      } else {
        await Symbol.updateOne(
          { strikePrice: 0 },
          { $push: { oiArray } }
        ).catch(errorHandler);
      }
    }
  } catch (error) {
    console.error("An error occurred:", error.message);
  }
}

async function initializeDb() {
  try {
    // Delete all documents in the following collections
    await mongoose.connection.db.collection("FINNIFTY").deleteMany({});
    await mongoose.connection.db.collection("BANKNIFTY").deleteMany({});
    await mongoose.connection.db.collection("NIFTY").deleteMany({});
  } catch (error) {
    console.error("Error deleting data:", error);
  }
}
//! ROUTING -------------------------------------------------------

//! endpoint for internal purposes -----------------------------------------
app.get("/update-oiData", async (req, res) => {
  const currentDay = luxon.DateTime.now()
    .setZone("Asia/Kolkata")
    .toFormat("dd-MM-yyyy");

  if (isTradingHoliday(currentDay)) {
    res.send("Trading Holiday, so don't drop previous day data");
  } else {
    try {
      const symList = ["NIFTY", "BANKNIFTY", "FINNIFTY"];

      const requests = symList.map((element) => {
        return getAndStore(element);
      });

      await Promise.all(requests).catch(errorHandler);

      res.send("OI data stored");
    } catch (error) {
      errorHandler(error);
      res.status(500).send("Internal Server Error");
    }
  }
});

app.get("/initialize-db", async (req, res) => {
  const currentDay = luxon.DateTime.now()
    .setZone("Asia/Kolkata")
    .toFormat("dd-MM-yyyy");

  if (isTradingHoliday(currentDay)) {
    res.send("Trading Holiday, so don't drop previous day data");
  } else {
    await initializeDb();
    res.send("db is initialized");
  }
});

//* not in daily use
app.get("/symbol-store", async (req, res) => {
  try {
    const url = "https://webapi.niftytrader.in/webapi/symbol/psymbol-list";

    const response = await axios.get(url).catch(errorHandler);
    const data = response.data.resultData;

    const Symbol = mongoose.model("symbol_list", symbolListSchema);

    await Symbol.collection.drop().catch(errorHandler);

    data.forEach(async (element) => {
      await Symbol.create({
        symbolName: element.symbol_name,
        lotSize: element.lot_size,
      });
    });
    res.send("Symbols stored");
  } catch (error) {
    errorHandler(error);
    res.status(500).send("Internal Server Error");
  }
});

//! endpoint to test ----------------------------------------
app.get("/", (req, res) => {
  res.send("Hey! this is OpitoNXT API running 🥳");
});

//! following are the endpoints for fetching data ---------------------------------------
app.get("/symbol-list", async (req, res) => {
  try {
    const Symbol = mongoose.model("symbol_list", symbolListSchema);

    const symObj = await Symbol.find({}).catch(errorHandler);

    // Map the data to get an array of symbol names
    const symList = symObj.map((element) => element.symbolName);

    res.send(symList);
  } catch (error) {
    errorHandler(error);
    res.status(500).send("Internal Server Error");
  }
});

app.get("/live-oicoi-ex/:symbol/:expiryDate", async (req, res) => {
  try {
    const { symbol, expiryDate } = req.params;

    const url =
      "https://webapi.niftytrader.in/webapi/option/fatch-option-chain";

    const response = await axios
      .get(url, {
        params: { symbol: symbol, expiryDate: expiryDate },
      })
      .catch(errorHandler);

    if (response) {
      const opDatas = response.data.resultData.opDatas;
      const oiData = [];
      const spot = opDatas[0].index_close;

      // sorting the api data and finding the atm
      opDatas.sort((a, b) => a.strike_price - b.strike_price);
      let atm = -1,
        atmIndex = -1;
      for (let i = 0; i < opDatas.length; i++) {
        if (opDatas[i].strike_price - spot >= 0) {
          atm = opDatas[i].strike_price;
          atmIndex = i;
          break;
        }
      }

      // filtering data to show only 10 strikes up and down of atm
      for (
        let i = Math.max(0, atmIndex - 10);
        i < Math.min(opDatas.length, atmIndex + 11);
        i++
      ) {
        const element = opDatas[i];
        oiData.push({
          atm: atm,
          strikePrice: element.strike_price,
          callsOi: parseFloat((element.calls_oi / 100000).toFixed(2)),
          callsCoi: parseFloat((element.calls_change_oi / 100000).toFixed(2)),
          putsOi: parseFloat((element.puts_oi / 100000).toFixed(2)),
          putsCoi: parseFloat((element.puts_change_oi / 100000).toFixed(2)),
        });
      }
      res.send(oiData);
    }
  } catch (error) {
    errorHandler(error);
    res.status(500).send("Internal Server Error");
  }
});

app.get("/expiry-dates/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const url =
      "https://webapi.niftytrader.in/webapi/option/fatch-option-chain";
    const response = await axios
      .get(url, {
        params: { symbol: symbol, expiryDate: "current" },
      })
      .catch(errorHandler);

    if (response) {
      const expDates = response.data.resultData.opExpiryDates;
      res.send(expDates);
    }
  } catch (error) {
    errorHandler(error);
    res.status(500).send("Internal Server Error");
  }
});

app.get("/total-coi/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const Total = mongoose.model(symbol, oiDataSchema, symbol);
    const data = await Total.findOne({ strikePrice: 0 }).catch(errorHandler);

    if (!data) {
      const currentTime = luxon.DateTime.now().setZone("Asia/Kolkata");
      // check if the current time is out of trading range or it's trading holiday
      if (!isWithinTradingTime(currentTime)) {
        res.send("Wait for market opening");
      } else {
        res.status(500).send("Internal Server Error");
      }
    } else {
      const oi = data.oiArray;
      const oiLacs = oi.map((element) => {
        const time = element.time;
        const spot = element.spot;
        const putLac = parseFloat((element.putsCoi / 100000).toFixed(2));
        const callLac = parseFloat((element.callsCoi / 100000).toFixed(2));
        let pcr = Math.abs(parseFloat((putLac / callLac).toFixed(2)));
        const oidiff = parseFloat((putLac - callLac).toFixed(2));
        pcr = putLac > 0 ? pcr : -pcr;
        const eleLacs = {
          spot: spot,
          pcr: pcr,
          oidiff: oidiff,
          time: time,
          putsCoi: putLac,
          callsCoi: callLac,
        };
        return eleLacs;
      });
      res.send(oiLacs);
    }
  } catch (error) {
    errorHandler(error);
    res.status(500).send("Internal Server Error");
  }
});

app.get("/sp-data/:symbol/:strike", async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const strike = parseInt(req.params.strike);

    const Sp = mongoose.model(symbol, oiDataSchema, symbol);

    const data = await Sp.findOne({ strikePrice: strike }).catch(errorHandler);

    if (!data) {
      const currentTime = luxon.DateTime.now().setZone("Asia/Kolkata");
      // check if the current time is out of trading range or it's trading holiday
      if (!isWithinTradingTime(currentTime)) {
        res.send("Wait for market opening");
      } else {
        res.status(500).send("Internal Server Error");
      }
    } else {
      const oi = data.oiArray;
      const oiLacs = oi.map((element) => {
        const time = element.time;
        const putLac = parseFloat((element.putsCoi / 100000).toFixed(2));
        const callLac = parseFloat((element.callsCoi / 100000).toFixed(2));
        const oidiff = parseFloat((putLac - callLac).toFixed(2));
        const eleLacs = {
          oidiff: oidiff,
          time: time,
        };
        return eleLacs;
      });
      res.send(oiLacs);
    }
  } catch (error) {
    errorHandler(error);
    res.status(500).send("Internal Server Error");
  }
});

app.get("/strikes-list/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const url =
      "https://webapi.niftytrader.in/webapi/option/fatch-option-chain";

    const response = await axios
      .get(url, {
        params: { symbol: symbol },
      })
      .catch(errorHandler);

    if (response) {
      const opDatas = response.data.resultData.opDatas;
      const spot = opDatas[0].index_close;
      const strikes = [];

      let strikeDiff = 1e9;

      for (let i = 21; i < opDatas.length; i++) {
        strikeDiff = Math.min(
          strikeDiff,
          Math.abs(opDatas[20].strike_price - opDatas[i].strike_price)
        );
      }

      const atm = Math.ceil(spot / strikeDiff) * strikeDiff;
      strikes.push(atm);
      for (let i = 1; i <= 5; i++) {
        strikes.push(atm - i * strikeDiff);
        strikes.push(atm + i * strikeDiff);
      }
      strikes.sort();
      res.send(strikes);
    }
  } catch (error) {
    errorHandler(error);
    res.status(500).send("Internal Server Error");
  }
});

//* endpoint to store the feedbacks in the db
app.post("/feedback", async (req, res) => {
  try {
    const Feedback = new mongoose.model("feedback", feedbackSchema);
    await Feedback.create({
      name: req.body.name,
      email: req.body.email,
      message: req.body.message,
    }).catch(errorHandler);
    res.status(201).json({ message: "Feedback saved successfully!" });
  } catch (error) {
    res.status(500).json({ error: "An error occurred while saving feedback." });
  }
});

//* listening on port
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log("listening for requests");
  });
});
