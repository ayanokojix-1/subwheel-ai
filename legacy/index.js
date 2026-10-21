require("dotenv").config();
const express = require("express");
const { listPlans, buyData } = require("./smeTools");

const app =express()

app.get("/",(req,res)=>{
    res.send("Hello world")
})
app.listen(3000,()=>{
    console.log("Server listening on port 3000")
})