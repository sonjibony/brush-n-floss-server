const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");

require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);



const port = process.env.PORT || 5000;

const app = express();

//middleware
app.use(cors());
app.use(express.json());

//mongobd

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.3nhngvm.mongodb.net/?retryWrites=true&w=majority`;
// console.log(uri);
const client = new MongoClient(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverApi: ServerApiVersion.v1,
});

//jwt middleware
function verifyJWT(req, res, next) {
  // console.log('token inside jwt',req.headers.authorization);
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send("unauthorized access");
  }
  const token = authHeader.split(" ")[1];

  jwt.verify(token, process.env.ACCESS_TOKEN, function (err, decoded) {
    if (err) {
      return res.status(403).send({ message: "forbidden access" });
    }
    req.decoded = decoded;
    next();
  });
}

async function run() {
  try {
    //collections
    const appointmentOptionCollection = client
      .db("brushNfloss")
      .collection("appointmentOptions");
    const bookingsCollection = client.db("brushNfloss").collection("bookings");
    const usersCollection = client.db("brushNfloss").collection("users");
    const doctorsCollection = client.db("brushNfloss").collection("doctors");
    const paymentCollection = client.db("brushNfloss").collection("payment");

    //ADMIN MIDDLEWARE (use verifyAdmin after verifyJWT)
const verifyAdmin = async (req,res,next) =>{
    // console.log('inside verifyAdmin', req.decoded.email);
    const decodedEmail = req.decoded.email;
      const query = { email: decodedEmail };
      const user = await usersCollection.findOne(query);

      if (user?.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }

    next();
}
    //use aggregate to query multiple collection and then merge data
    //appointment options api
    app.get("/appointmentOptions", async (req, res) => {
      const date = req.query.date;
      // console.log(date);
      const query = {};
      const options = await appointmentOptionCollection.find(query).toArray();

      //getting the bookings of the provided date
      const bookingQuery = { appointmentDate: date };
      const alreadyBooked = await bookingsCollection
        .find(bookingQuery)
        .toArray();
      //careful : (
      options.forEach((option) => {
        const optionBooked = alreadyBooked.filter(
          (book) => book.treatment === option.name
        );
        const bookedSlots = optionBooked.map((book) => book.slot);
        const remainingSlots = option.slots.filter(
          (slot) => !bookedSlots.includes(slot)
        );
        option.slots = remainingSlots;
        // console.log(date, option.name, remainingSlots.length);
      });
      res.send(options);
    });

    //using mongodb pipeline
    app.get("/v2/appointmentOptions", async (req, res) => {
      const date = req.query.date;
      const options = await appointmentOptionCollection
        .aggregate([
          {
            $lookup: {
              from: "bookings",
              localField: "name",
              foreignField: "treatment",

              pipeline: [
                {
                  $match: {
                    $expr: {
                      $eq: ["$appointmentDate", date],
                    },
                  },
                },
              ],
              as: "booked",
            },
          },
          {
            $project: {
              name: 1,
              price: 1,
              slots: 1,
              booked: {
                $map: {
                  input: "$booked",
                  as: "book",
                  in: "$$book.slot",
                },
              },
            },
          },
          {
            $project: {
              name: 1,
              price:1,
              slots: {
                $setDifference: ["$slots", "$booked"],
              },
            },
          },
        ])
        .toArray();
      res.send(options);
    });


    //specialty api
    app.get('/appointmentSpecialty', async(req,res) => {
        const query = {}
        const result = await appointmentOptionCollection.find(query).project({name: 1}).toArray();
        res.send(result);
    })

    //bookings api get
    app.get("/bookings", verifyJWT, async (req, res) => {
      const email = req.query.email;
      const decodedEmail = req.decoded.email;

      if (email !== decodedEmail) {
        return res.status(403).send({ message: "forbidden access" });
      }

      const query = { email: email };
      const bookings = await bookingsCollection.find(query).toArray();
      res.send(bookings);
    });

    //specific booking api
   app.get('/bookings/:id', async(req, res) =>{
    const id = req.params.id;
    const query = {_id: ObjectId(id)};
    const booking = await bookingsCollection.findOne(query);
    res.send(booking);
   }) 

    //bookings insert
    app.post("/bookings", async (req, res) => {
      const booking = req.body;
      console.log(booking);

      //limit
      const query = {
        appointmentDate: booking.appointmentDate,
        email: booking.email,
        treatment: booking.treatment,
      };

      const alreadyBooked = await bookingsCollection.find(query).toArray();

      if (alreadyBooked.length) {
        const message = `You already have a booking on ${booking.appointmentDate}`;
        return res.send({ acknowledged: false, message });
      }

      const result = await bookingsCollection.insertOne(booking);
      res.send(result);
    });


    //stripe
app.post('/create-payment-intent', async(req,res) =>{
    const booking = req.body;
    const price = booking.price;
    const amount = price * 100;

    const paymentIntent = await stripe.paymentIntents.create({
        currency: 'usd',
        amount: amount,
        "payment_method_types": [
            "card"
        ]
    });
    res.send({
        clientSecret: paymentIntent.client_secret,
      });


})


//payment collection api
app.post('/payments', async(req,res) =>{
    const payment = req.body;
    const result = await paymentCollection.insertOne(payment);
    const id = payment.bookingId;
    const filter = {_id: ObjectId(id)}
    const updatedDoc = {
        $set: {
            paid: true,
            transactionId: payment.transactionId
        }
    }
    const updatedResult = await bookingsCollection.updateOne(filter, updatedDoc)
    res.send(result);
})
    //jwt
    app.get("/jwt", async (req, res) => {
      const email = req.query.email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      if (user) {
        const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, {
          expiresIn: "1h",
        });
        return res.send({ accessToken: token });
      }
      console.log(user);
      res.status(403).send({ accessToken: "" });
    });

    //users api
    app.get("/users", async (req, res) => {
      const query = {};
      const users = await usersCollection.find(query).toArray();
      res.send(users);
    });

    //admin find
    app.get("/users/admin/:email", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ isAdmin: user?.role === "admin" });
    });

    //users sent
    app.post("/users", async (req, res) => {
      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    //admin api
    app.put("/users/admin/:id", verifyJWT, verifyAdmin, async (req, res) => {
      

      const id = req.params.id;
      const filter = { _id: ObjectId(id) };
      const options = { upsert: true };
      const updatedDoc = {
        $set: {
          role: "admin",
        },
      };
      const result = await usersCollection.updateOne(
        filter,
        updatedDoc,
        options
      );
      res.send(result);
    });


//temporary way to update price field on appointment options
// app.get('/addPrice', async(req, res) =>{
//     const filter ={}
//     const options = {upsert: true}
//     const updatedDoc ={
//         $set: {
//             price: 99
//         }
//     }
//     const result = await appointmentOptionCollection.updateMany(filter, updatedDoc,options);
//     res.send(result);
// })


//doctors api
app.get('/doctors', verifyJWT, verifyAdmin, async(req,res) =>{
    const query = {};
    const doctors = await doctorsCollection.find(query).toArray();
    res.send(doctors);
})

//doctors inserting 
app.post('/doctors', verifyJWT, verifyAdmin, async(req,res) =>{
    const doctor = req.body;
    const result = await doctorsCollection.insertOne(doctor);
    res.send(result);
});

//deleting doctor
app.delete('/doctors/:id', verifyJWT, verifyAdmin, async(req,res) => {
    const id = req.params.id;
    const filter = {_id: ObjectId(id)};
    const result = await doctorsCollection.deleteOne(filter);
    res.send(result);
})


  } finally {
  }
}
run().catch(console.log);

app.get("/", async (req, res) => {
  res.send("brush n floss server running");
});

app.listen(port, () => console.log(`Brush N Floss running on ${port}`));
