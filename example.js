
function calculateTotal(price, quantity) {
  var total = price * quantity;
  console.log("Calculating total");
  return total;
}

function divide(a, b) {
  return a / b;
}

const result = calculateTotal(100, 2);
console.log(result);
